// Replacing this process with another build of OpenCode, as a TUI does once the background service runs a newer
// build (tui's context/update-restart.tsx). `execve` keeps the process id, its terminal, its working directory and
// the pane a terminal multiplexer such as herdr shows it in; only the program changes. The TUI's run returns the plan,
// the default handler schedules it, and the process's teardown runs it once every finalizer has run.
import path from "node:path"

export type Plan = {
  readonly command: ReadonlyArray<string>
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

let scheduled: Plan | undefined

/** Replaces the process by `plan` when it would otherwise exit. */
export function schedule(plan: Plan) {
  scheduled = plan
}

/** The plan scheduled, once. */
export function take() {
  const plan = scheduled
  scheduled = undefined
  return plan
}

/**
 * Replaces this process with `command` and `args`, its environment plus `env`. Returns only when it cannot: then it
 * runs the command as a child on the same terminal and resolves with the child's exit code, so the terminal still
 * ends up in the new build.
 */
export async function replace(plan: Plan): Promise<number> {
  const [file, ...rest] = plan.command
  if (file === undefined) return 1
  const argv = [...plan.command, ...plan.args]
  const env = { ...process.env, ...plan.env }
  if (typeof Bun !== "undefined" && (process.platform === "darwin" || process.platform === "linux")) {
    const failed = await execve(path.resolve(file), argv, env).catch((error: unknown) => error)
    process.stderr.write(`opencode: could not replace the process (${String(failed)}); starting ${file} under it\n`)
  }
  const { spawn } = await import("node:child_process")
  return new Promise<number>((resolve) =>
    spawn(file, [...rest, ...plan.args], { env, stdio: "inherit" })
      .on("exit", (code) => resolve(code ?? 1))
      .on("error", () => resolve(1)),
  )
}

// ioctl's FIOCLEX, which marks a descriptor close-on-exec. It takes no third argument: fcntl(fd, F_SETFD, FD_CLOEXEC)
// passes its flag as a variadic argument, which Apple's arm64 ABI puts on the stack where a plain FFI call never does.
const FIOCLEX = process.platform === "darwin" ? 0x20006601 : 0x5451

async function execve(file: string, argv: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>) {
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    execve: { args: [FFIType.cstring, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  })
  // The buffers stay referenced until execve returns, so nothing frees the strings it reads.
  const strings: Buffer[] = []
  const text = (value: string) => {
    const buffer = Buffer.from(value + "\0")
    strings.push(buffer)
    return buffer
  }
  const vector = (values: ReadonlyArray<string>) => {
    const pointers = new BigUint64Array(values.length + 1)
    values.forEach((value, index) => (pointers[index] = BigInt(ptr(text(value)))))
    return pointers
  }
  const argvPointers = vector(argv)
  const envPointers = vector(
    Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`])),
  )
  // Only the terminal crosses into the new program: every other descriptor (sockets, files, the runtime's own) closes.
  for (let fd = 3; fd < 1024; fd++) libc.symbols.ioctl(fd, FIOCLEX)
  const result = libc.symbols.execve(ptr(text(file)), ptr(argvPointers), ptr(envPointers))
  libc.close()
  return new Error(`execve returned ${result}`)
}

export * as Reexec from "./reexec"
