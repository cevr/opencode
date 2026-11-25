export * as ShellTool from "./shell.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import type { Shell as ShellSchema } from "@opencode/schema/shell"
import type { Tool } from "@opencode/schema/tool"
import { Deferred, Duration, Effect, Fiber, Option, Schema, Stream } from "effect"
import { Agent } from "../../agent.js"
import { Bus } from "../../bus.js"
import { CodeModeTool } from "../../codemode/tool.js"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { Environment } from "../../environment/index.js"
import { Flag } from "../../flag.js"
import { Job } from "../../job.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { NonNegativeInt } from "../../schema.js"
import { Session } from "../../session.js"
import { SessionMessage } from "../../session/message.js"
import { SessionSchema } from "../../session/schema.js"
import { Shell } from "../../shell.js"
import { ShellPermissions } from "../../shell/permissions.js"
import { ShellSelect } from "../../shell/select.js"
import { ShellResult } from "../../shell/result.js"
import { ToolOutput } from "../../tool-output.js"
import { toolFailure } from "../runtime.js"

export const name = "shell"
// How long a call the user interrupted waits for its stopped command to exit before settling with the output so far.
const INTERRUPT_WAIT = "500 millis"
// How long a foreground command runs before it moves to the background and its call returns its handle (upstream's
// default timeout); `experimental.shell_background_after` replaces it (0: never), a call's `timeout` overrides both.
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
// Under full_codemode, upstream's longer foreground default.
const CODE_MODE_TIMEOUT_MS = 10 * 60 * 1_000
// How long a `wait` action waits by default.
const DEFAULT_WAIT_MS = 10 * 60 * 1_000
// The output a handle shows: the tail of a command that moved to the background or started there, and the
// most of what is new that a check, wait or kill shows.
const TAIL_LINES = 20
const READ_LINES = 40
const READ_LIMIT = 64 * 1024

const NO_POLLING =
  "Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly checking, sleeping and reading or searching the output file is polling, not useful work. You may check the current output if it lets you do useful work now, or wait on it when nothing else is left to do. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes."
const OS =
  process.platform === "darwin"
    ? "macOS"
    : process.platform === "win32"
      ? "Windows"
      : process.platform === "linux"
        ? "Linux"
        : process.platform

const minutes = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1_000)} s`)

const description = (shell?: string, codeMode = false) =>
  [
    "Execute a shell command and return its handle: its shell ID, state (running, exited, killed), exit code, runtime and output.",
    ...(shell ? [`Commands run on ${OS} using ${shell}.`] : []),
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned.",
    "Rely on automatic truncation unless filtering the output is more useful.",
    "A command that ends in the foreground returns its handle already exited, with its output.",
    `One still running after its timeout (default ${minutes(codeMode ? CODE_MODE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)}) moves to the background: the call returns its running handle with the output so far, and the command keeps running.`,
    "background: true returns the handle at once.",
    "You are notified when a background command ends.",
    'Act on a handle with this same tool, its action and its id: { action: "check", id } shows its state and the output since your last look, { action: "wait", id, ms } waits up to ms for it to end, { action: "kill", id } stops it.',
    '{ action: "list" } lists this session\'s shells.',
    "The current session ID is available in the OPENCODE_SESSION_ID environment variable.",
  ].join(" ")

export const Action = Schema.Literals(["run", "check", "wait", "kill", "list"])
export type Action = typeof Action.Type

// The fields each action takes; `action` itself goes with all of them.
const FIELDS = {
  run: ["command", "workdir", "timeout", "description", "background"],
  check: ["id", "offset", "lines"],
  wait: ["id", "ms", "offset", "lines"],
  kill: ["id"],
  list: [],
} as const satisfies Record<Action, ReadonlyArray<string>>

// The flags that picked a form before `action` did, and the action form that took each one's place.
const FLAGS: ReadonlyArray<readonly [field: string, form: (id: string) => string]> = [
  ["kill", (id) => `{ action: "kill", id: ${id} }`],
  ["list", () => `{ action: "list" }`],
  ["wait", (id) => `{ action: "wait", id: ${id}, ms }`],
]

// One flat object with an `action` enum, never a root anyOf/oneOf: Anthropic and OpenAI reject a tool input
// schema whose root is a union. Which fields go with which action is checked by `mode`. Its rest stays open so
// a field no action takes (an old `kill: true`) reaches `mode`, which names the action form to use, instead of
// being dropped on the way in.
export const Input = Schema.StructWithRest(
  Schema.Struct({
    action: Schema.optionalKey(Action).annotate({
      description: `What to do: "run" a command (the default when command is given), "check" a shell (its state and the output since your last look), "wait" for it to end, "kill" it (SIGTERM to its process group, SIGKILL after ${Duration.toSeconds(Shell.KILL_GRACE)} s, then its final handle; no end notice follows), or "list" this session's shells, running and recently ended, one line each.`,
    }),
    command: Schema.optionalKey(Schema.String).annotate({
      description: "Run: the shell command string to execute.",
    }),
    workdir: Schema.optionalKey(Schema.String).annotate({
      description:
        "Run: working directory to execute it in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
    }),
    timeout: Schema.optionalKey(NonNegativeInt).annotate({
      description: `Run: milliseconds. For a foreground command, how long it may run before it moves to the background and the call returns its handle (it is never killed); 0 waits until it ends. Defaults to ${DEFAULT_TIMEOUT_MS}. For a background command, a deadline after which it is killed; none by default.`,
    }),
    description: Schema.optionalKey(Schema.String).annotate({
      description: "Run: a few words on what the command does, shown when the session's shells are listed.",
    }),
    background: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Run: run it in the background and return its handle immediately (useful for dev servers and long-running builds). You do not need '&' at the end of the command. You will be notified when it ends. DO NOT poll for completion.",
    }),
    id: Schema.optionalKey(Schema.String).annotate({
      description: "Check, wait, kill: the shell ID (sh_…) an earlier shell call returned.",
    }),
    ms: Schema.optionalKey(NonNegativeInt).annotate({
      description: `Wait: milliseconds to wait for the command to end before returning its handle. Defaults to ${DEFAULT_WAIT_MS}.`,
    }),
    offset: Schema.optionalKey(NonNegativeInt).annotate({
      description: `Check, wait: return the output from this byte offset (a handle's \`next\`), up to ${READ_LIMIT / 1024} KiB.`,
    }),
    lines: Schema.optionalKey(NonNegativeInt).annotate({
      description: "Check, wait: return the output's last this many lines.",
    }),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
type Input = typeof Input.Type

// `restart`: a server that took the command over from a previous one settled its call in the background.
const Backgrounded = Schema.Literals(["start", "limit", "user", "restart"])
type Backgrounded = typeof Backgrounded.Type

const State = Schema.Literals(["running", "exited", "killed"])
type State = typeof State.Type

// Field order is the order a result is written in (upstream 5756d59a68): small fields first and the large ones
// (`output`, a listed `command`) last, so a result cut to the tool output limit keeps its state.
const idFields = {
  id: Schema.String,
  state: State,
  exitCode: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
}
const runFields = {
  pid: Schema.optionalKey(NonNegativeInt),
  timedOut: Schema.optionalKey(Schema.Boolean),
  runtimeMs: Schema.Number.annotate({ description: "Milliseconds it ran, or has run so far" }),
}

export const Handle = Schema.Struct({
  ...idFields,
  // Upstream dcb24c74dc: Code Mode sees only the structured output, so it carries the reason too. Beside the exit
  // code and signal it stands in for, as upstream's result has it.
  killed: Schema.optionalKey(Schema.String).annotate({
    description:
      "Why the command ended without an exit code, when the reason is known: the machine's worker restarted or lost the process, or the local process daemon stopped",
  }),
  ...runFields,
  backgrounded: Schema.optionalKey(Backgrounded),
  next: Schema.Number.annotate({ description: "The byte offset to pass as `offset` to read on from" }),
  truncated: Schema.Boolean.annotate({ description: "Output before what `output` shows was left out" }),
  output: Schema.String,
})
export type Handle = typeof Handle.Type

const ListOutput = Schema.Struct({
  shells: Schema.Array(
    Schema.Struct({
      ...idFields,
      ...runFields,
      size: Schema.Number.annotate({ description: "Bytes of output it wrote" }),
      started: Schema.Number.annotate({ description: "Unix milliseconds" }),
      background: Schema.Boolean,
      description: Schema.String,
      command: Schema.String,
    }),
  ),
})

const Output = Schema.Union([Handle, ListOutput])

const stateOf = (info: ShellSchema.Info): State =>
  info.status === "running" ? "running" : info.status === "exited" && info.signal === undefined ? "exited" : "killed"
const runtimeOf = (info: ShellSchema.Info) => Math.max(0, (info.time.completed ?? Date.now()) - info.time.started)
const shortCommand = (command: string) => {
  const line = command.trim().split("\n")[0] ?? ""
  return line.length > 80 || command.trim().includes("\n") ? `${line.slice(0, 79)}…` : line
}
const describe = (info: ShellSchema.Info) =>
  typeof info.metadata.description === "string" && info.metadata.description !== ""
    ? info.metadata.description
    : shortCommand(info.command)
const seconds = (ms: number) =>
  ms < 10_000
    ? `${(ms / 1_000).toFixed(1)} s`
    : ms < 120_000
      ? `${Math.round(ms / 1_000)} s`
      : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`
// The suffix of `text` that holds its last `count` lines, its final newline kept.
const lastLines = (text: string, count: number) => {
  if (count === 0) return ""
  let index = text.endsWith("\n") ? text.length - 1 : text.length
  for (let seen = 0; seen < count; seen++) {
    index = text.lastIndexOf("\n", index - 1)
    if (index === -1) return text
  }
  return text.slice(index + 1)
}

const shellState = (info: ShellSchema.Info) => ({
  id: info.id,
  state: stateOf(info),
  ...(info.pid !== undefined ? { pid: info.pid } : {}),
  ...(info.exit !== undefined ? { exitCode: info.exit } : {}),
  ...(info.signal !== undefined ? { signal: info.signal } : {}),
  ...(info.status === "timeout" ? { timedOut: true } : {}),
  runtimeMs: runtimeOf(info),
})

const stateWords = (handle: Pick<Handle, "state" | "exitCode" | "signal" | "timedOut">) => {
  if (handle.state === "running") return "running"
  if (handle.state === "exited") return `exited ${handle.exitCode ?? "?"}`
  const signal = handle.signal ? ` ${handle.signal}` : ""
  return handle.timedOut ? `timed out, killed${signal}` : `killed${signal}`
}

// The handle's header line: `sh_… · exited 0 · 1.2 s`, then whatever else the call has to say.
const header = (handle: Pick<Handle, "id" | "state" | "exitCode" | "signal" | "timedOut" | "runtimeMs">, notes: ReadonlyArray<string> = []) =>
  [handle.id, stateWords(handle), seconds(handle.runtimeMs), ...notes].join(" · ")

const text = (value: string) => ({ type: "text" as const, text: value })

// Metadata every handle carries; a command call adds the fields the host's shell row read before handles.
const handleMetadata = (handle: Handle) => {
  const { output: _, ...rest } = handle
  return rest
}

// What the agent is told once its command runs in the background.
const guidance = (id: string, file: string, pid?: number, by?: Backgrounded) =>
  [
    ...(pid === undefined ? [] : [`PID: ${pid}`]),
    ...(by === "limit" ? ["Do not start another copy while it is running."] : []),
    `It keeps running, and you will be notified when it ends. shell({ action: "check", id: "${id}" }) checks it, shell({ action: "wait", id: "${id}", ms: <ms> }) waits for it to end, shell({ action: "kill", id: "${id}" }) stops it. Output is streaming to: ${file}`,
    NO_POLLING,
  ].join("\n\n")

// Which action a call is, with what it acts on, or why it is none.
type Mode =
  | { readonly type: "run"; readonly command: string }
  | { readonly type: "check" | "wait" | "kill"; readonly id: string }
  | { readonly type: "list" }
const names = (fields: ReadonlyArray<string>) => fields.join(", ")
export const mode = (input: Input): Mode | string => {
  const given = Object.keys(input).filter((key) => key !== "action" && input[key] !== undefined)
  const id = typeof input.id === "string" ? JSON.stringify(input.id) : '"sh_…"'
  const flag = FLAGS.find(([field]) => given.includes(field))
  if (flag) return `The shell tool has no ${flag[0]} field; use ${flag[1](id)}.`
  const known = new Set(Object.values(FIELDS).flat())
  const unknown = given.filter((key) => !known.has(key as never))
  if (unknown.length) return `The shell tool has no field ${names(unknown)}; it takes action and the fields of that action.`
  const action = input.action ?? (input.command !== undefined ? "run" : undefined)
  if (action === undefined)
    return input.id !== undefined
      ? `Give the action to take on ${input.id}: { action: "check", id: ${id} }, { action: "wait", id: ${id}, ms } or { action: "kill", id: ${id} }.`
      : 'Give command to run a command, { action: "check" | "wait" | "kill", id } to act on one of this session\'s shells, or { action: "list" } to list them.'
  const takes: ReadonlyArray<string> = FIELDS[action]
  const extra = given.filter((key) => !takes.includes(key))
  if (extra.length)
    return `action "${action}" takes ${takes.length ? names(takes) : "no other fields"}, not ${names(extra)}.`
  if (action === "list") return { type: "list" }
  if (action === "run")
    return input.command === undefined ? 'action "run" needs command.' : { type: "run", command: input.command }
  if (input.id === undefined) return `action "${action}" needs id, the shell ID (sh_…) a shell call returned.`
  if (input.offset !== undefined && input.lines !== undefined) return "Give offset or lines, not both."
  return { type: action, id: input.id }
}

// A command's end, as the job that ran it settled it.
type Settled = {
  info: ShellSchema.Info
  output: string
  truncated: boolean
  size: number
  // Why it was killed when no exit code or signal of its own tells, e.g. the process daemon stopped.
  killed?: string
}

// The handle of a settled command as its job saw it end.
const settledHandle = (ended: Settled): Handle => ({
  ...shellState(ended.info),
  output: ended.output,
  next: ended.size,
  truncated: ended.truncated,
  ...(ended.killed !== undefined ? { killed: ended.killed } : {}),
})

// Waits for the command to end and reads what it printed.
const finished = Effect.fnUntraced(function* (shell: Shell.Interface, info: ShellSchema.Info) {
  const result = yield* shell.result(info)
  if (!result.capture) return yield* new Shell.NotFoundError({ id: info.id })
  const size = yield* shell.output(info.id, { cursor: Number.MAX_SAFE_INTEGER }).pipe(
    Effect.map((latest) => latest.size),
    Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(0)),
  )
  return {
    info: result.info,
    ...result.capture,
    size,
  } satisfies Settled
})

// The job that waits on a command for its call (or its session, once backgrounded).
const startJob = Effect.fnUntraced(function* (
  jobs: Job.Interface,
  shell: Shell.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly info: ShellSchema.Info
    readonly background?: boolean
    readonly notificationID?: SessionMessage.ID
  },
) {
  const info = input.info
  const settled = yield* Deferred.make<Settled>()
  const job = yield* jobs.start({
    // CodeMode children share a tool-call ID, but each shell must own its job.
    id: info.id,
    type: name,
    title: info.command,
    metadata: { sessionID: input.sessionID, shellID: info.id },
    recovery: {
      kind: "shell",
      sessionID: input.sessionID,
      shellID: info.id,
      command: info.command,
    },
    ...(input.notificationID ? { notificationID: input.notificationID } : {}),
    background: input.background,
    run: finished(shell, info).pipe(
      Effect.tap((ended) => Deferred.succeed(settled, ended)),
      // The job's own record of the end, which a restart recovers: the header, then the output.
      Effect.map((ended) =>
        [header(shellState(ended.info), ended.killed ? [ended.killed] : []), ended.output || "(no output)"].join("\n"),
      ),
      // Interrupting the job (its registry closing) stops the command too, unless the server is handing its daemon
      // over: then the command keeps running for the next server.
      Effect.onInterrupt(() =>
        shell.handoffPrepared() ? Effect.void : shell.stop(info.id, "killed").pipe(Effect.ignore, Effect.asVoid),
      ),
    ),
    // Cancelling the job stops the command, keeping it and its output file.
    cancel: shell.stop(info.id, "killed").pipe(Effect.ignore, Effect.asVoid),
  })
  return { job, settled }
})

// A background command's end notice carries its final handle: its state and the output since the agent last saw it
// (`final`, by default the tail its job saw). One the agent's own call already answered (`answered`) sends none.
const notify = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "synthetic">,
  jobs: Job.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly id: string
    readonly shellID: ShellSchema.ID
    readonly command: string
    readonly timeout: number
    readonly settled: Deferred.Deferred<Settled>
    readonly final?: (ended: Settled) => Effect.Effect<{ handle: Handle; notes: ReadonlyArray<string> }>
    readonly answered?: () => boolean
  },
) {
  const info = (yield* jobs.wait({ id: input.id })).info
  if (!info || info.status === "running") return
  if (input.answered?.()) {
    if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
    return
  }
  const ended = info.status === "completed" ? yield* Deferred.await(input.settled) : undefined
  const final = ended
    ? input.final
      ? yield* input.final(ended)
      : { handle: settledHandle(ended), notes: ended.killed ? [ended.killed] : [] }
    : undefined
  const body = final
    ? [
        header(final.handle, final.notes),
        final.handle.output || "(no new output)",
        ...(final.handle.timedOut ? [`It ran past its timeout of ${input.timeout} ms and was killed.`] : []),
      ].join("\n")
    : info.status === "error"
      ? (info.error ?? "Command failed")
      : "Cancelled"
  // A session deleted while its command ran has no one left to tell.
  yield* sessions
    .synthetic({
      ...(info.notificationID ? { id: info.notificationID } : {}),
      sessionID: input.sessionID,
      source: "shell",
      description: input.command,
      ...ShellResult.notification({
        jobID: input.id,
        shellID: input.shellID,
        command: input.command,
        state: info.status,
        text: body,
        output: final
          ? {
              output: final.handle.output,
              truncated: final.handle.truncated,
              ...(final.handle.exitCode !== undefined ? { exit: final.handle.exitCode } : {}),
              ...(final.handle.signal !== undefined ? { signal: final.handle.signal } : {}),
              ...(final.handle.timedOut ? { timeout: true } : {}),
              ...(ended?.killed !== undefined ? { killed: ended.killed } : {}),
            }
          : undefined,
        ...(final ? { handle: handleMetadata(final.handle) } : {}),
      }),
    })
    .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void))
  if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
})

/** The tool result of a call whose command a server that took it over moved to the background. */
export const backgroundToolResult = (info: ShellSchema.Info) => {
  const handle: Handle = { ...shellState(info), output: "", next: 0, truncated: false, backgrounded: "restart" }
  const running = handle.state === "running"
  return {
    content: [
      text(header(handle, ["moved to the background when the server restarted"])),
      text(
        running
          ? guidance(info.id, info.file, info.pid, "restart")
          : "It ended during the restart; its end notice carries its output.",
      ),
    ],
    metadata: { ...handleMetadata(handle), status: "running" as const, shellID: info.id },
  }
}

/**
 * Watches a command taken over from a previous server as a background job of its session, and notifies the
 * session when it finishes, as for a command the model ran in the background. A finished command's notice is
 * admitted before this returns.
 */
export const reattach = Effect.fnUntraced(function* (input: {
  readonly shell: Shell.Interface
  readonly jobs: Job.Interface
  readonly sessions: Pick<Session.Interface, "synthetic">
  readonly sessionID: SessionSchema.ID
  readonly info: ShellSchema.Info
  // The job's existing durable row, if the previous server had backgrounded it.
  readonly notificationID?: SessionMessage.ID
}) {
  const { job, settled } = yield* startJob(input.jobs, input.shell, { ...input, background: true })
  const notifying = notify(input.sessions, input.jobs, {
    sessionID: input.sessionID,
    id: job.id,
    shellID: input.info.id,
    command: input.info.command,
    timeout: 0,
    settled,
  })
  const current = yield* input.shell.get(input.info.id).pipe(Effect.option)
  if (Option.isSome(current) && current.value.status !== "running")
    return yield* notifying.pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to report a recovered shell command", { id: input.info.id, error }),
      ),
    )
  yield* input.shell.watch(notifying)
})

export const Plugin = {
  id: "opencode.tool.shell",
  effect: Effect.fn("ShellTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const jobs = yield* Job.Service
    const access = yield* FileAccess.Service
    const currentWorkingDirectory = yield* Environment.workingDirectoryResolver
    const shell = yield* Shell.Service
    const shellSelect = yield* ShellSelect.Service
    const compatibleShell = shellSelect.resolve({ priority: "compat" })
    const permission = yield* Permission.Service
    const config = yield* Config.Service
    // Shells whose end the agent's own call already answered (its kill, or a wait that saw the end): no notice.
    const answered = new Set<string>()
    // Where each shell's output was last shown to the agent: a check without an offset reads on from here.
    const cursors = new Map<string, number>()

    const backgroundAfter = Effect.fnUntraced(function* (input: Input, context: Tool.Context) {
      if (input.timeout !== undefined) return input.timeout
      // Inside Code Mode a slow script backgrounds as a whole (CodeModeJob), so its shell waits longer, as upstream's.
      const fallback = context.codemode ? CODE_MODE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
      return Config.latest(yield* config.entries(), "experimental")?.shell_background_after ?? fallback
    })

    const outputLimits = Effect.fnUntraced(function* () {
      const limits = Config.latest(yield* config.entries(), "tool_output")
      return { lines: limits?.max_lines ?? ToolOutput.MAX_LINES, bytes: limits?.max_bytes ?? ToolOutput.MAX_BYTES }
    })

    // The output a handle shows: from `offset` on, the last `lines` lines, or else what is new since the agent
    // last saw this shell, cut to the last `cap` lines when there is more.
    const page = Effect.fnUntraced(function* (
      id: ShellSchema.ID,
      how: { offset?: number; lines?: number; cap: { lines: number; bytes: number } },
    ) {
      if (how.offset !== undefined) {
        const read = yield* shell.output(id, { cursor: how.offset, limit: READ_LIMIT })
        const latest = read.cursor < read.size
        return { text: read.output, next: read.cursor, skipped: 0, dropped: read.truncated, more: latest }
      }
      const size = (yield* shell.output(id, { cursor: Number.MAX_SAFE_INTEGER })).size
      const from = how.lines !== undefined ? 0 : Math.min(cursors.get(id) ?? 0, size)
      const start = Math.max(from, size - how.cap.bytes)
      const read = yield* shell.output(id, { cursor: start, limit: how.cap.bytes })
      const shown = lastLines(read.output, how.lines ?? how.cap.lines)
      const shownFrom = read.cursor - Buffer.byteLength(shown)
      return {
        text: shown,
        next: read.cursor,
        skipped: how.lines !== undefined ? 0 : Math.max(0, shownFrom - from),
        dropped: read.truncated,
        more: false,
      }
    })

    // The handle of shell `id` as it stands, with the output `how` asks for; records what the agent saw.
    const look = Effect.fnUntraced(function* (
      id: ShellSchema.ID,
      how: { offset?: number; lines?: number; cap: { lines: number; bytes: number } },
    ) {
      const read = yield* page(id, how)
      const info = yield* shell.get(id)
      cursors.set(id, read.next)
      const handle: Handle = {
        ...shellState(info),
        output: read.text,
        next: read.next,
        truncated: read.skipped > 0 || read.dropped,
      }
      const notes = [
        ...(read.skipped > 0 ? [`${read.skipped} earlier bytes not shown (offset ${read.next - read.skipped - Buffer.byteLength(read.text)} reads them)`] : []),
        ...(read.dropped ? ["the oldest output was dropped"] : []),
        ...(read.more ? [`more follows (offset ${read.next})`] : []),
      ]
      return { handle, notes, info }
    })

    // The session's own shell, or a failure naming the ones it has.
    const own = Effect.fnUntraced(function* (id: string, context: Tool.Context) {
      const shells = (yield* shell.list({ exited: true })).filter((info) => info.metadata.sessionID === context.sessionID)
      const found = shells.find((info) => info.id === id)
      if (found) return found
      return yield* Effect.fail(
        new Error(
          `No shell ${id} in this session.${shells.length ? ` Its shells: ${shells.map((info) => info.id).join(", ")}` : " It has none."}`,
        ),
      )
    })

    // Internal plugins are not re-run on config changes, so reload the tool transform instead.
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    const flags = yield* Flag.Service

    const prepare = Effect.fn("ShellTool.prepare")(function* (
      invocation: ShellCreateBefore,
      context: Tool.Context,
      requested: { readonly cwd: string; readonly target: FileAccess.Target },
    ) {
      const workingDirectory = yield* currentWorkingDirectory
      // Resolved before the hooks ran; only a hook that moved the working directory needs it resolved again. It always
      // resolves from a base, so a moved path is a plain path on the machine the command was asked for.
      const target =
        invocation.cwd === requested.cwd
          ? requested.target
          : yield* access.resolve({
              path: invocation.cwd,
              base:
                requested.target.environment.id === workingDirectory.environment.id
                  ? workingDirectory
                  : requested.target,
              kind: "directory",
            })
      invocation.cwd = target.absolute
      const timeout = invocation.timeout
      const requests = yield* ShellPermissions.requests(access, {
        command: invocation.command,
        program: invocation.shell,
        target,
        policy: Effect.gen(function* () {
          const session = yield* sessions.get(context.sessionID)
          const agent = yield* agents.resolve(context.agent)
          return Permission.Policy.fromRules(agent?.permissions ?? [], session.permissions ?? [])
        }),
      })
      yield* Effect.forEach(
        requests,
        (request) => permission.assert({ ...request, ...Permission.invocation(context) }),
        { discard: true },
      )
      // Approval can outlive the directory, so validate immediately before spawning.
      const workdir = yield* Environment.typeFollowing(target.environment.files, target.absolute).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(
            new Error(
              target.machine === undefined
                ? `Working directory does not exist: ${target.absolute}`
                : `Working directory does not exist on ${target.machine}: ${target.absolute}`,
            ),
          ),
        ),
      )
      if (workdir !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
      return timeout
    })

    // A background command's end notice carries its final handle: its state and the output since the agent last
    // saw it. One the agent's own call already answered sends none. Not in this Location's scope: a daemon command
    // outlives a Location that closes while the server runs, and its session must still hear how it ended.
    const notifyWhenDone = (
      sessionID: SessionSchema.ID,
      id: string,
      shellID: ShellSchema.ID,
      command: string,
      timeout: number,
      settled: Deferred.Deferred<Settled>,
    ) =>
      shell.watch(
        notify(sessions, jobs, {
          sessionID,
          id,
          shellID,
          command,
          timeout,
          settled,
          answered: () => answered.delete(shellID),
          final: (ended) =>
            Effect.gen(function* () {
              const { handle, notes } = yield* look(shellID, { cap: yield* outputLimits() })
              return { handle, notes: ended.killed ? [ended.killed, ...notes] : notes }
            }).pipe(
              Effect.catch(() =>
                Effect.succeed({ handle: settledHandle(ended), notes: ended.killed ? [ended.killed] : [] }),
              ),
            ),
        }),
      )

    // Stops the command of a call the user asked to stop, and fails the call with the output so far. The command
    // stays observable, output file included.
    const cancelled = Effect.fnUntraced(function* (info: ShellSchema.Info, jobID: string) {
      yield* shell.stop(info.id, "killed").pipe(Effect.ignore)
      // The stop escalates to SIGKILL on its own; the session does not wait for that to settle the call.
      const result = yield* shell.result(info, { wait: INTERRUPT_WAIT })
      // The stopped job settles from the same exit; this only releases it.
      yield* jobs.cancel(jobID)
      const stopped = ShellResult.interrupted(result)
      return yield* new ToolFailure({
        message: stopped.message,
        // The notice ends the message; renderers show what precedes it as the output, like a finished call's.
        metadata: {
          interrupted: true,
          truncated: result.capture?.truncated ?? false,
          shellID: info.id,
          notice: stopped.notice,
        },
      })
    })

    // Runs a command: its handle once it ends, or once it moves to the background.
    const run = Effect.fnUntraced(function* (input: Input, command: string, context: Tool.Context) {
      // A background call's timeout kills it; a foreground call's moves it to the background.
      // Upstream e1fb08afc5: an automation has nobody to tell about a backgrounded command. Give it a deadline,
      // never a session job; an omitted or zero timeout takes upstream's foreground default.
      const automated = context.automation !== undefined
      const background = !automated && input.background === true
      const timeout = automated
        ? input.timeout || (context.codemode ? CODE_MODE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
        : background
          ? (input.timeout ?? 0)
          : 0
      const limit = background || automated ? 0 : yield* backgroundAfter(input, context)
      let finalTimeout = timeout
      // Uninterruptible from spawning to blocking, so an interrupt cannot orphan a started command.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Listens for the user's stop for the whole call, starting before the command does, so a stop always
          // reaches this tool through `cancel` instead of interrupting it, even while the command starts.
          const stopped = yield* Deferred.make<void>()
          const listener = context.cancel
            ? yield* context.cancel.pipe(
                Effect.andThen(Deferred.succeed(stopped, undefined)),
                Effect.interruptible,
                Effect.forkChild({ startImmediately: true }),
              )
            : undefined
          // Raced against the slow work that precedes the command, so a stop then ends the call at once.
          const stoppedBeforeStart = Deferred.await(stopped).pipe(
            Effect.andThen(
              Effect.fail(new ToolFailure({ message: "Command interrupted by the user before it started." })),
            ),
          )
          return yield* Effect.gen(function* () {
            const workingDirectory = yield* currentWorkingDirectory
            // The same default `Shell.create` gives the hooks, so `prepare` can tell whether one moved it.
            const cwd = input.workdir ?? workingDirectory.absolute
            const target = yield* restore(
              Effect.raceFirst(
                access.resolve({
                  path: cwd,
                  base: input.workdir === undefined ? workingDirectory : undefined,
                  kind: "directory",
                }),
                stoppedBeforeStart,
              ),
            )
            const info = yield* shell.create(
              {
                command,
                cwd,
                // The environment a command runs in is settled from the requested working directory, before
                // hooks run. A hook may move the directory; today that cannot change the environment.
                environment: target.environment,
                timeout,
                shell: yield* compatibleShell,
                metadata: {
                  sessionID: context.sessionID,
                  // The call in the transcript that started the command, so clients can tell whose it is.
                  callID: (yield* CodeModeTool.Parent) ?? context.id,
                  ...(input.description ? { description: input.description } : {}),
                  ...(background ? { background: true } : {}),
                },
                waited: !background && !automated,
                toolCall: {
                  sessionID: context.sessionID,
                  assistantMessageID: context.messageID,
                  callID: context.id,
                },
              },
              (invocation) =>
                Effect.gen(function* () {
                  invocation.env.AGENT = "1"
                  invocation.env.OPENCODE = "1"
                  invocation.env.AI_AGENT ||= "opencode"
                  invocation.env.OPENCODE_SESSION_ID = context.sessionID
                  // Asking for permission can take a while; a stop then ends the call before any command starts.
                  finalTimeout = yield* restore(
                    Effect.raceFirst(prepare(invocation, context, { cwd, target }), stoppedBeforeStart),
                  )
                }),
            )
            yield* context.progress({ shellID: info.id })

            if (automated) {
              const ended = yield* restore(finished(shell, info)).pipe(
                Effect.onInterrupt(() => shell.stop(info.id, "killed").pipe(Effect.ignore)),
              )
              const output = ShellResult.output({ info: ended.info, capture: ended })
              const messages = [output.output, ShellResult.notice(output, finalTimeout)].filter(
                (message): message is string => message !== undefined && message !== "",
              )
              if (output.timeout) return yield* new ToolFailure({ message: messages.join("\n\n") })
              return { handle: settledHandle(ended), content: messages.map(text) }
            }

            const { job, settled } = yield* startJob(jobs, shell, { sessionID: context.sessionID, info })
            // Stopped while the command was starting: stop it now.
            if (yield* Deferred.isDone(stopped)) return yield* cancelled(info, job.id)

            // In the background: the running handle, its output so far, and how to act on it.
            const moved = Effect.fnUntraced(function* (by: Backgrounded) {
              yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, finalTimeout, settled)
              const seen = yield* look(info.id, { cap: { lines: TAIL_LINES, bytes: READ_LIMIT } }).pipe(
                Effect.catchTag("Shell.NotFoundError", () =>
                  Effect.succeed({
                    handle: { ...shellState(info), output: "", next: 0, truncated: false } satisfies Handle,
                    notes: [] as string[],
                    info,
                  }),
                ),
              )
              const handle: Handle = { ...seen.handle, backgrounded: by }
              const where =
                by === "start"
                  ? "started in the background"
                  : by === "limit"
                    ? `moved to the background at its ${minutes(limit)} limit`
                    : "moved to the background by the user"
              const ran = handle.state === "running"
              return {
                handle,
                content: [
                  text(header(handle, [where, ...seen.notes])),
                  text(handle.output.trimEnd() || (ran ? "(no output yet)" : "(no output)")),
                  ...(ran ? [text(guidance(info.id, info.file, seen.info.pid, by))] : []),
                ],
              }
            })

            if (background) {
              yield* jobs.background(job.id)
              return yield* moved("start")
            }

            // Past its limit the command moves to the background, as a ctrl+b would move it (upstream's timeout
            // backgrounding). `running`: a command that settled as the limit passed keeps its foreground result.
            const waiting = jobs.block({ id: job.id, sessionID: context.sessionID })
            const blocked =
              limit > 0
                ? waiting.pipe(
                    Effect.timeoutOption(limit),
                    Effect.flatMap((result) =>
                      Option.isSome(result)
                        ? Effect.succeed(result.value)
                        : jobs
                            .background(job.id, { running: true })
                            .pipe(
                              Effect.map((info) =>
                                info ? { type: "backgrounded" as const, info, timedOut: true } : undefined,
                              ),
                            ),
                    ),
                  )
                : waiting
            // A user's stop arrives through `cancel`. Any interrupt stops the command too, unless the server is
            // handing its daemon over: then the command and its job keep running, and the next server takes the
            // call over and moves the command to the background.
            const outcome = yield* restore(
              Effect.raceFirst(
                blocked.pipe(Effect.map((result) => ({ type: "settled" as const, result }))),
                Deferred.await(stopped).pipe(Effect.as({ type: "cancelled" as const })),
              ),
            ).pipe(
              Effect.onInterrupt(() => (shell.handoffPrepared() ? Effect.void : jobs.cancel(job.id).pipe(Effect.ignore))),
            )
            if (outcome.type === "cancelled") return yield* cancelled(info, job.id)
            const result = outcome.result
            if (result?.type === "backgrounded") {
              // Clears its timeout and keeps it under the background retention allowance.
              yield* shell.background(info.id).pipe(Effect.ignore)
              return yield* moved("timedOut" in result ? "limit" : "user")
            }
            if (result?.info.status === "error")
              return yield* Effect.fail(new Error(result.info.error ?? "Command failed"))
            if (result?.info.status === "cancelled") return yield* Effect.fail(new Error("Command cancelled"))

            // Ended in the foreground: its handle already exited, with the output a shell call has always shown.
            const ended = yield* Deferred.await(settled)
            answered.delete(info.id)
            cursors.set(info.id, ended.size)
            const handle = settledHandle(ended)
            return {
              handle,
              content: [text(header(handle, ended.killed ? [ended.killed] : [])), text(ended.output)],
            }
          }).pipe(Effect.ensuring(listener ? Fiber.interrupt(listener) : Effect.void))
        }),
      )
    })

    // Checks, waits on or kills one of the session's shells by its ID.
    const act = Effect.fnUntraced(function* (input: Input, action: "check" | "wait" | "kill", id: string, context: Tool.Context) {
      const found = yield* own(id, context)
      const how = {
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.lines !== undefined ? { lines: input.lines } : {}),
        cap: { lines: READ_LINES, bytes: READ_LIMIT },
      }
      const notes: string[] = []
      if (action === "kill") {
        if (found.status === "running") answered.add(found.id)
        else notes.push("it had already ended")
        yield* shell.kill(found.id)
      } else if (action === "wait" && found.status === "running") {
        const ms = input.ms ?? DEFAULT_WAIT_MS
        // Claimed while it waits, so an end it sees sends no notice too.
        answered.add(found.id)
        const ended = yield* shell
          .wait(found.id)
          .pipe(
            Effect.timeoutOption(Duration.millis(ms)),
            Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(Option.none())),
          )
        if (Option.isNone(ended)) {
          answered.delete(found.id)
          notes.push(`still running after waiting ${seconds(ms)}`)
        }
      }
      const seen = yield* look(found.id, how)
      const handle = seen.handle
      const empty = input.offset !== undefined || input.lines !== undefined ? "(no output)" : "(no new output)"
      return {
        handle,
        content: [text(header(handle, [...notes, ...seen.notes, `next ${handle.next}`])), text(handle.output || empty)],
      }
    })

    const list = Effect.fnUntraced(function* (context: Tool.Context) {
      const infos = (yield* shell.list({ exited: true })).filter((info) => info.metadata.sessionID === context.sessionID)
      const shells = yield* Effect.forEach(infos, (info) =>
        shell.output(info.id, { cursor: Number.MAX_SAFE_INTEGER }).pipe(
          Effect.map((latest) => latest.size),
          Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(0)),
          Effect.map((size) => ({
            ...shellState(info),
            size,
            description: describe(info),
            command: shortCommand(info.command),
            started: info.time.started,
            background: info.metadata.background === true,
          })),
        ),
      )
      const lines = shells.length
        ? shells.map((item) => `${header(item, [`${item.size} bytes`])} · ${item.description}`).join("\n")
        : "This session has no shell commands."
      return { shells, text: lines }
    })

    // The descriptions name the selected shell, so they're rebuilt whenever it changes.
    const bus = yield* Bus.Service
    yield* bus.subscribe(ShellSelect.Event.Updated).pipe(
      Stream.runForEach(() => ctx.tool.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )
    const runSync = Effect.runSyncWith(yield* Effect.context())
    yield* ctx.tool
      .transform((editor) => {
        // Named in both the direct and the Code Mode description, so a model knows the shell either way.
        const shellName = ShellSelect.name(runSync(compatibleShell))
        editor.add({
          name,
          // With full_codemode, shell is allowed in Code Mode and pinned so the catalog always lists it. The fork keeps
          // its one handle-shaped input and output in both modes; only the stated default timeout differs.
          options: flags.resolve(loaded.entries).full_codemode.enabled
            ? { codemode: { pinned: true, description: description(shellName, true) } }
            : { codemode: false },
          description: description(shellName),
          input: Input,
          output: Output,
          execute: (input, context) => {
            const form = mode(input)
            if (typeof form === "string")
              return Effect.fail(new ToolFailure({ message: form, error: new Error(form) }))
            if (form.type === "list")
              return list(context).pipe(
                Effect.map((listed) => ({
                  output: { shells: listed.shells },
                  content: [text(listed.text)],
                  metadata: { count: listed.shells.length },
                })),
              )
            if (form.type !== "run")
              return act(input, form.type, form.id, context).pipe(
                Effect.map(({ handle, content }) => ({ output: handle, content, metadata: handleMetadata(handle) })),
                Effect.mapError(
                  (error) => new ToolFailure({ message: `Unable to act on shell ${form.id}: ${error.message}`, error }),
                ),
              )
            return run(input, form.command, context).pipe(
              // Shell spans, including the job that waits for a backgrounded command, name the call that started them.
              Effect.annotateSpans({
                "gen_ai.tool.call.id": context.id,
                ...(input.background === true ? { "opencode.shell.background": true } : {}),
              }),
              Effect.map(({ handle, content }) => ({
                output: handle,
                content,
                metadata: {
                  ...handleMetadata(handle),
                  // What the host's shell row read before handles: a background handle's live shell, the exit.
                  status: handle.backgrounded ? ("running" as const) : ("completed" as const),
                  ...(handle.backgrounded ? { shellID: handle.id } : {}),
                  ...(handle.backgrounded
                    ? {}
                    : ShellResult.metadata({
                        output: handle.output,
                        truncated: handle.truncated,
                        ...(handle.exitCode !== undefined ? { exit: handle.exitCode } : {}),
                        ...(handle.signal !== undefined ? { signal: handle.signal } : {}),
                        ...(handle.timedOut ? { timeout: true } : {}),
                      })),
                },
              })),
              Effect.mapError(toolFailure(`Unable to execute command: ${form.command}`)),
            )
          },
        })
      })
      .pipe(Effect.orDie)
  }),
}
