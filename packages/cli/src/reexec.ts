// Replacing this process with another build of OpenCode, as a TUI does once the background service runs a newer
// build (tui's context/update-restart.tsx). `execve` keeps the process id, its terminal, its working directory and
// the pane a terminal multiplexer such as herdr shows it in; only the program changes. The TUI's run returns the plan,
// the default handler schedules it, and the process's teardown runs it once every finalizer has run.
import { rmSync } from "node:fs"
import path from "node:path"
import { selfCommand } from "./util/process"

export type Plan = {
  /** The build to move onto, and the arguments and environment it starts with. */
  readonly command: ReadonlyArray<string>
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  /** The environment this build starts again with when the move fails: the same handoff, and the build not to retry. */
  readonly stay: Readonly<Record<string, string>>
  /** The handoff file, deleted when no program is left to read it. */
  readonly handoff?: string
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
 * Replaces this process with `command` and `args`, its environment plus `env`. When that fails (the build is gone or
 * does not run), the TUI stays on its own build: this process becomes `stay` (this build's command by default) with
 * the same arguments and the environment plus `plan.stay`, which hands it the drafts and names the build not to retry.
 * Returns only when no exec works: then it runs `stay` as a child on the same terminal and resolves with its exit code.
 */
export async function replace(plan: Plan, stay: ReadonlyArray<string> = selfCommand()): Promise<number> {
  const exec = typeof Bun !== "undefined" && (process.platform === "darwin" || process.platform === "linux")
  const [file] = plan.command
  if (exec && file !== undefined) {
    const failed = await execve(path.resolve(file), [...plan.command, ...plan.args], {
      ...process.env,
      ...plan.env,
    }).catch((error: unknown) => error)
    process.stderr.write(`opencode: could not move onto ${file} (${String(failed)}); staying on this build\n`)
  }
  const [self, ...rest] = stay
  const env = { ...process.env, ...plan.stay }
  if (exec && self !== undefined) await execve(path.resolve(self), [...stay, ...plan.args], env).catch(() => undefined)
  const { spawn } = await import("node:child_process")
  return new Promise<number>((resolve) => {
    const failed = () => {
      if (plan.handoff) rmSync(plan.handoff, { force: true })
      resolve(1)
    }
    if (self === undefined) return failed()
    spawn(self, [...rest, ...plan.args], { env, stdio: "inherit" })
      .on("exit", (code) => resolve(code ?? 1))
      .on("error", failed)
  })
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
