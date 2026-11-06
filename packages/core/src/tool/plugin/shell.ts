export * as ShellTool from "./shell.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import type { Shell as ShellSchema } from "@opencode/schema/shell"
import type { Tool } from "@opencode/schema/tool"
import { Deferred, Duration, Effect, Fiber, Option, Schema, Scope } from "effect"
import { Config } from "../../config.js"
import { Environment } from "../../environment/index.js"
import { Job } from "../../job.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { NonNegativeInt } from "../../schema.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { Shell } from "../../shell.js"
import { ShellParse } from "../../shell/parse.js"
import { ShellSelect } from "../../shell/select.js"
import { ShellResult } from "../../shell/result.js"
import { ToolOutput } from "../../tool-output.js"

export const name = "shell"
// How long a foreground command runs before it moves to the background and its call returns its handle;
// `experimental.shell_background_after` replaces it (0: never), a call's `timeout` overrides both.
export const DEFAULT_BACKGROUND_AFTER_MS = 10 * 60 * 1_000
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

const description = (shell?: string) =>
  [
    "Execute a shell command and return its handle: its shell ID, state (running, exited, killed), exit code, runtime and output.",
    ...(shell ? [`Commands run on ${OS} using ${shell}.`] : []),
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned.",
    "Rely on automatic truncation unless filtering the output is more useful.",
    "A command that ends in the foreground returns its handle already exited, with its output.",
    `One still running after its timeout (default ${minutes(DEFAULT_BACKGROUND_AFTER_MS)}) moves to the background: the call returns its running handle with the output so far, and the command keeps running.`,
    "background: true returns the handle at once.",
    "You are notified when a background command ends.",
    "Act on a handle with this same tool and its id instead of a command: { id } checks it (its state and the output since your last look), { id, wait: ms } waits up to ms for it to end, { id, kill: true } stops it.",
    "{ list: true } lists this session's shells.",
  ].join(" ")

export const Input = Schema.Struct({
  command: Schema.optionalKey(Schema.String).annotate({
    description: "Shell command string to execute. Give either command or id.",
  }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description:
      "With command: working directory to execute it in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
  }),
  timeout: Schema.optionalKey(NonNegativeInt).annotate({
    description: `With command: milliseconds. For a foreground command, how long it may run before it moves to the background and the call returns its handle (it is never killed); 0 waits until it ends. Defaults to ${DEFAULT_BACKGROUND_AFTER_MS}. For a background command, a deadline after which it is killed; none by default.`,
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: "With command: a few words on what the command does, shown when the session's shells are listed.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "With command: run it in the background and return its handle immediately (useful for dev servers and long-running builds). You do not need '&' at the end of the command. You will be notified when it ends. DO NOT poll for completion.",
  }),
  id: Schema.optionalKey(Schema.String).annotate({
    description:
      "A shell ID (sh_…) an earlier shell call returned: act on that command instead of running one. Alone, it returns the handle's state and the output since your last look.",
  }),
  wait: Schema.optionalKey(NonNegativeInt).annotate({
    description: "With id: milliseconds to wait for the command to end before returning its handle.",
  }),
  kill: Schema.optionalKey(Schema.Boolean).annotate({
    description: `With id: stop the command (SIGTERM to its process group, SIGKILL after ${Duration.toSeconds(Shell.KILL_GRACE)} s) and return its final handle. No end notice follows.`,
  }),
  offset: Schema.optionalKey(NonNegativeInt).annotate({
    description: `With id: return the output from this byte offset (a handle's \`next\`), up to ${READ_LIMIT / 1024} KiB.`,
  }),
  lines: Schema.optionalKey(NonNegativeInt).annotate({
    description: "With id: return the output's last this many lines.",
  }),
  list: Schema.optionalKey(Schema.Boolean).annotate({
    description: "List this session's shells, running and recently ended, one line each.",
  }),
})
type Input = typeof Input.Type

const Backgrounded = Schema.Literals(["start", "limit", "user"])
type Backgrounded = typeof Backgrounded.Type

const State = Schema.Literals(["running", "exited", "killed"])
type State = typeof State.Type

const stateFields = {
  id: Schema.String,
  state: State,
  exitCode: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
  timedOut: Schema.optionalKey(Schema.Boolean),
  runtimeMs: Schema.Number.annotate({ description: "Milliseconds it ran, or has run so far" }),
}

export const Handle = Schema.Struct({
  ...stateFields,
  output: Schema.String,
  next: Schema.Number.annotate({ description: "The byte offset to pass as `offset` to read on from" }),
  truncated: Schema.Boolean.annotate({ description: "Output before what `output` shows was left out" }),
  backgrounded: Schema.optionalKey(Backgrounded),
})
export type Handle = typeof Handle.Type

const ListOutput = Schema.Struct({
  shells: Schema.Array(
    Schema.Struct({
      ...stateFields,
      size: Schema.Number.annotate({ description: "Bytes of output it wrote" }),
      description: Schema.String,
      command: Schema.String,
      started: Schema.Number.annotate({ description: "Unix milliseconds" }),
      background: Schema.Boolean,
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
const guidance = (id: string, file: string) =>
  [
    `It keeps running, and you will be notified when it ends. shell({ id: "${id}" }) checks it, shell({ id: "${id}", wait: <ms> }) waits for it to end, shell({ id: "${id}", kill: true }) stops it. Output is streaming to: ${file}`,
    NO_POLLING,
  ].join("\n\n")

// Which of the tool's three forms a call is, or why it is none of them.
type Mode = { readonly type: "run"; readonly command: string } | { readonly type: "act"; readonly id: string } | { readonly type: "list" }
export const mode = (input: Input): Mode | string => {
  const present = (keys: ReadonlyArray<keyof Input>) => keys.filter((key) => input[key] !== undefined)
  const forms = [input.command !== undefined, input.id !== undefined, input.list === true].filter(Boolean).length
  if (forms === 0) return "Give command to run a command, id to act on one of this session's shells, or list: true to list them."
  if (input.command !== undefined && input.id !== undefined)
    return "Give either command (to run a command) or id (to act on a shell you started), not both."
  if (forms > 1) return "list: true takes no command or id."
  if (input.list === true) {
    const extra = present(["workdir", "timeout", "description", "background", "wait", "kill", "offset", "lines"])
    return extra.length ? `list: true takes no other fields (got ${extra.join(", ")}).` : { type: "list" }
  }
  if (input.id !== undefined) {
    const extra = present(["workdir", "timeout", "description", "background"])
    if (extra.length) return `${extra.join(", ")} only go with command; with id, give wait, kill, offset or lines.`
    if (input.kill === true && input.wait !== undefined) return "Give kill or wait, not both."
    if (input.offset !== undefined && input.lines !== undefined) return "Give offset or lines, not both."
    return { type: "act", id: input.id }
  }
  const extra = present(["wait", "kill", "offset", "lines"])
  if (extra.length) return `${extra.join(", ")} only go with id, the shell ID of a command already started.`
  return { type: "run", command: input.command ?? "" }
}

// A foreground command's end, as the job that ran it settled it.
type Settled = {
  info: ShellSchema.Info
  output: string
  truncated: boolean
  size: number
}

export const Plugin = {
  id: "opencode.tool.shell",
  effect: Effect.fn("ShellTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const scope = yield* Scope.Scope
    const environment = yield* Environment.Service
    const access = yield* FileAccess.Service
    const shell = yield* Shell.Service
    const shellSelect = yield* ShellSelect.Service
    const compatibleShell = shellSelect.resolve({ priority: "compat" })
    const permission = yield* Permission.Service
    const config = yield* Config.Service
    // Shells whose end the agent's own call already answered (its kill, or a wait that saw the end): no notice.
    const answered = new Set<string>()
    // Where each shell's output was last shown to the agent: a check without an offset reads on from here.
    const cursors = new Map<string, number>()

    const backgroundAfter = Effect.fnUntraced(function* (input: Input) {
      if (input.timeout !== undefined) return input.timeout
      return Config.latest(yield* config.entries(), "experimental")?.shell_background_after ?? DEFAULT_BACKGROUND_AFTER_MS
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

    const prepare = Effect.fn("ShellTool.prepare")(function* (invocation: ShellCreateBefore, context: Tool.Context) {
      const source = {
        type: "tool" as const,
        messageID: context.messageID,
        id: context.id,
      }
      const target = yield* access.resolve({ path: invocation.cwd, kind: "directory" })
      invocation.cwd = target.absolute
      const timeout = invocation.timeout
      const parsed = yield* ShellParse.scan(invocation.command, invocation.shell, target.absolute)
      const directories = yield* Effect.forEach(parsed.directories, (directory) =>
        access.resolve({
          path: FileAccess.resolvePath(target.absolute, directory),
          kind: "directory",
        }),
      )
      yield* access.authorizeExternal([target, ...directories], context)
      if (parsed.commands.length > 0)
        yield* permission.assert({
          action: name,
          resources: parsed.commands.map((command) => command.resource),
          save: parsed.commands.map((command) => command.save),
          sessionID: context.sessionID,
          agent: context.agent,
          source,
        })
      // Approval can outlive the directory, so validate immediately before spawning.
      const workdir = yield* Environment.typeFollowing(environment.files, target.absolute).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(new Error(`Working directory does not exist: ${target.absolute}`)),
        ),
      )
      if (workdir !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
      return timeout
    })

    // A background command's end notice carries its final handle: its state and the output since the agent last
    // saw it. One the agent's own call already answered sends none.
    const notifyWhenDone = Effect.fn("ShellTool.notifyWhenDone")(
      function* (
        sessionID: SessionSchema.ID,
        id: string,
        shellID: ShellSchema.ID,
        command: string,
        timeout: number,
        settled: Deferred.Deferred<Settled>,
      ) {
        const info = (yield* jobs.wait({ id })).info
        if (!info || info.status === "running") return
        if (answered.delete(shellID)) {
          if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
          return
        }
        const ended = info.status === "completed" ? yield* Deferred.await(settled) : undefined
        const final = ended
          ? yield* look(shellID, { cap: yield* outputLimits() }).pipe(
              Effect.map(({ handle, notes }) => ({ handle, notes })),
              Effect.catchTag("Shell.NotFoundError", () =>
                Effect.succeed({
                  handle: {
                    ...shellState(ended.info),
                    output: ended.output,
                    next: ended.size,
                    truncated: ended.truncated,
                  } satisfies Handle,
                  notes: [] as string[],
                }),
              ),
            )
          : undefined
        const body = final
          ? [
              header(final.handle, final.notes),
              final.handle.output || "(no new output)",
              ...(final.handle.timedOut ? [`It ran past its timeout of ${timeout} ms and was killed.`] : []),
            ].join("\n")
          : info.status === "error"
            ? (info.error ?? "Command failed")
            : "Cancelled"
        yield* sessions.synthetic({
          ...(info.notificationID ? { id: info.notificationID } : {}),
          sessionID,
          description: command,
          ...ShellResult.notification({
            jobID: id,
            shellID,
            command,
            state: info.status,
            text: body,
            output: final
              ? {
                  output: final.handle.output,
                  truncated: final.handle.truncated,
                  ...(final.handle.exitCode !== undefined ? { exit: final.handle.exitCode } : {}),
                  ...(final.handle.signal !== undefined ? { signal: final.handle.signal } : {}),
                  ...(final.handle.timedOut ? { timeout: true } : {}),
                }
              : undefined,
            ...(final ? { handle: handleMetadata(final.handle) } : {}),
          }),
        })
        if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
      },
      Effect.forkIn(scope, { startImmediately: true }),
    )

    // Runs a command: its handle once it ends, or once it moves to the background.
    const run = Effect.fnUntraced(function* (input: Input, command: string, context: Tool.Context) {
      // A background call's timeout kills it; a foreground call's moves it to the background.
      const background = input.background === true
      const timeout = background ? (input.timeout ?? 0) : 0
      const limit = background ? 0 : yield* backgroundAfter(input)
      let finalTimeout = timeout
      const info = yield* shell.create(
        {
          command,
          cwd: input.workdir,
          timeout,
          shell: yield* compatibleShell,
          metadata: {
            sessionID: context.sessionID,
            ...(input.description ? { description: input.description } : {}),
            ...(background ? { background: true } : {}),
          },
        },
        (invocation) =>
          Effect.gen(function* () {
            invocation.env.AGENT = "1"
            invocation.env.OPENCODE = "1"
            invocation.env.AI_AGENT ||= "opencode"
            invocation.env.OPENCODE_SESSION_ID = context.sessionID
            finalTimeout = yield* prepare(invocation, context)
          }),
      )
      yield* context.progress({ shellID: info.id })

      const settled = yield* Deferred.make<Settled>()
      const job = yield* jobs.start({
        // CodeMode children share a tool-call ID, but each shell must own its job.
        id: info.id,
        type: name,
        title: info.command,
        metadata: { sessionID: context.sessionID, shellID: info.id },
        recovery: {
          kind: "shell",
          sessionID: context.sessionID,
          shellID: info.id,
          command: info.command,
        },
        run: Effect.gen(function* () {
          const result = yield* shell.result(info)
          if (!result.capture) return yield* new Shell.NotFoundError({ id: info.id })
          const size = yield* shell.output(info.id, { cursor: Number.MAX_SAFE_INTEGER }).pipe(
            Effect.map((latest) => latest.size),
            Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(0)),
          )
          return { info: result.info, output: result.capture.output, truncated: result.capture.truncated, size }
        }).pipe(
          Effect.tap((ended) => Deferred.succeed(settled, ended)),
          // The job's own record of the end, which a restart recovers: the header, then the output.
          Effect.map((ended) => [header(shellState(ended.info)), ended.output || "(no output)"].join("\n")),
          Effect.onInterrupt(() => shell.remove(info.id).pipe(Effect.ignore)),
        ),
      })

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
            ...(ran ? [text(guidance(info.id, info.file))] : []),
          ],
        }
      })

      if (background) {
        yield* jobs.background(job.id)
        return yield* moved("start")
      }

      // At the limit the command moves to the background as a ctrl+b would move it, unless it settled first.
      let byLimit = false
      const timer =
        limit > 0
          ? yield* Effect.sleep(limit).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  byLimit = true
                  return jobs.background(job.id, { running: true })
                }),
              ),
              Effect.forkChild({ startImmediately: true }),
            )
          : undefined
      const result = yield* jobs.block({ id: job.id, sessionID: context.sessionID }).pipe(
        Effect.onInterrupt(() => jobs.cancel(job.id).pipe(Effect.ignore)),
        Effect.ensuring(timer ? Fiber.interrupt(timer) : Effect.void),
      )
      if (result?.type === "backgrounded") {
        yield* shell.background(info.id).pipe(Effect.ignore)
        return yield* moved(byLimit ? "limit" : "user")
      }
      if (result?.info.status === "error") return yield* Effect.fail(new Error(result.info.error ?? "Command failed"))
      if (result?.info.status === "cancelled") return yield* Effect.fail(new Error("Command cancelled"))

      // Ended in the foreground: its handle already exited, with the output a shell call has always shown.
      const ended = yield* Deferred.await(settled)
      answered.delete(info.id)
      cursors.set(info.id, ended.size)
      const handle: Handle = {
        ...shellState(ended.info),
        output: ended.output,
        next: ended.size,
        truncated: ended.truncated,
      }
      return { handle, content: [text(header(handle)), text(ended.output)] }
    })

    // Checks, waits on or kills one of the session's shells by its ID.
    const act = Effect.fnUntraced(function* (input: Input, id: string, context: Tool.Context) {
      const found = yield* own(id, context)
      const how = {
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.lines !== undefined ? { lines: input.lines } : {}),
        cap: { lines: READ_LINES, bytes: READ_LIMIT },
      }
      const notes: string[] = []
      if (input.kill === true) {
        if (found.status === "running") answered.add(found.id)
        else notes.push("it had already ended")
        yield* shell.kill(found.id)
      } else if (input.wait !== undefined && found.status === "running") {
        // Claimed while it waits, so an end it sees sends no notice too.
        answered.add(found.id)
        const ended = yield* shell
          .wait(found.id)
          .pipe(
            Effect.timeoutOption(Duration.millis(input.wait)),
            Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(Option.none())),
          )
        if (Option.isNone(ended)) {
          answered.delete(found.id)
          notes.push(`still running after waiting ${seconds(input.wait)}`)
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

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description: description(),
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
            if (form.type === "act")
              return act(input, form.id, context).pipe(
                Effect.map(({ handle, content }) => ({ output: handle, content, metadata: handleMetadata(handle) })),
                Effect.mapError(
                  (error) => new ToolFailure({ message: `Unable to act on shell ${form.id}: ${error.message}`, error }),
                ),
              )
            return run(input, form.command, context).pipe(
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
              Effect.mapError((error) => new ToolFailure({ message: `Unable to execute command: ${form.command}`, error })),
            )
          },
        }),
      )
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        tool.description = description(ShellSelect.name(yield* compatibleShell))
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
