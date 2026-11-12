// Replacing this process with another build of OpenCode, as a TUI does once the background service runs a newer
// build (tui's context/update-restart.tsx). `execve` keeps the process id, its terminal, its working directory and
// the pane a terminal multiplexer such as herdr shows it in; only the program changes. The TUI's run returns the plan,
// the default handler schedules it, and the process's teardown runs it once every finalizer has run.
import { rmSync, writeFileSync } from "node:fs"
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

/** The variable that tells a TUI the watcher it runs under, by the file the watcher reads its next move from. */
export const WATCH_ENV = "OPENCODE_TUI_WATCH"
/** The exit status by which a TUI under a watcher asks it to run the move it wrote. */
export const MOVE_STATUS = 75

// Taken out of the environment as the CLI starts, so nothing this process starts (the service, a tool's shell, another
// TUI in it) believes it runs under this watcher.
const watching = process.env[WATCH_ENV] || undefined
delete process.env[WATCH_ENV]

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const line = (command: ReadonlyArray<string>) => command.map(quote).join(" ")
const exports = (env: Readonly<Record<string, string>>) =>
  Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`)

/**
 * The watcher a move runs as: a shell, in this process's place, that starts the new build as its child with the
 * handoff, and watches it. The new build deletes the handoff once its screen is up. When it exits with the handoff
 * still there, it never came up (it crashed, or does not run at all), so the watcher becomes this build again, with
 * the drafts and the build not to retry. A later move of the child comes back through the watcher (status 75 with the
 * next watcher in `slot`), so the watchers never stack.
 */
export function watcher(plan: Plan & { readonly handoff: string }, stay: ReadonlyArray<string>, slot: string) {
  const [self] = stay
  return [
    `slot=${quote(slot)}`,
    "(",
    ...exports({ ...plan.env, [WATCH_ENV]: slot }),
    `exec ${line([...plan.command, ...plan.args])}`,
    ")",
    "status=$?",
    `if [ "$status" -eq ${MOVE_STATUS} ] && [ -f "$slot" ]; then next=$(cat "$slot"); rm -f "$slot"; exec /bin/sh -c "$next"; fi`,
    `if [ -f ${quote(plan.handoff)} ]; then`,
    `  echo ${quote(`opencode: ${plan.command[0] ?? "the new build"} did not start; staying on this build`)} >&2`,
    `  if [ -x ${quote(self ?? "")} ]; then`,
    `    unset ${WATCH_ENV}`,
    ...exports(plan.stay).map((item) => `    ${item}`),
    `    exec ${line([...stay, ...plan.args])}`,
    "  fi",
    `  rm -f ${quote(plan.handoff)}`,
    "fi",
    'exit "$status"',
  ].join("\n")
}

/**
 * Moves this process onto `plan`'s build. In this process's place (same process id, terminal and working directory)
 * runs a watcher (`watcher`) that starts the build and falls back to this one, `stay` (this build's command by
 * default), when the build does not come up. A TUI already under a watcher writes the next one for it and returns
 * `MOVE_STATUS` for its caller to exit with. Without a handoff, or when the watcher cannot start, it replaces the
 * process with the build directly, and with `stay` when that fails too. Returns only when no exec works: then it runs
 * `stay` as a child on the same terminal and resolves with its exit code.
 */
export async function replace(
  plan: Plan,
  stay: ReadonlyArray<string> = selfCommand(),
  env: Readonly<Record<string, string | undefined>> = process.env,
  current: string | undefined = watching,
): Promise<number> {
  const exec = typeof Bun !== "undefined" && (process.platform === "darwin" || process.platform === "linux")
  const handoff = plan.handoff
  if (handoff !== undefined) {
    if (current) {
      writeFileSync(current, watcher({ ...plan, handoff }, stay, current), { mode: 0o600 })
      return MOVE_STATUS
    }
    if (exec) {
      const slot = path.join(path.dirname(handoff), `${process.pid}.next`)
      const script = watcher({ ...plan, handoff }, stay, slot)
      await execve("/bin/sh", ["/bin/sh", "-c", script], env).catch(() => undefined)
    }
  }
  const [file] = plan.command
  if (exec && file !== undefined) {
    const failed = await execve(path.resolve(file), [...plan.command, ...plan.args], { ...env, ...plan.env }).catch(
      (error: unknown) => error,
    )
    process.stderr.write(`opencode: could not move onto ${file} (${String(failed)}); staying on this build\n`)
  }
  const [self, ...rest] = stay
  const stayEnv = { ...env, ...plan.stay }
  if (exec && self !== undefined)
    await execve(path.resolve(self), [...stay, ...plan.args], stayEnv).catch(() => undefined)
  const { spawn } = await import("node:child_process")
  return new Promise<number>((resolve) => {
    const failed = () => {
      if (plan.handoff) rmSync(plan.handoff, { force: true })
      resolve(1)
    }
    if (self === undefined) return failed()
    spawn(self, [...rest, ...plan.args], { env: stayEnv, stdio: "inherit" })
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
