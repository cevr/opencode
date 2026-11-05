export * as ShellTool from "./shell.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import type { Shell as ShellSchema } from "@opencode/schema/shell"
import type { Tool } from "@opencode/schema/tool"
import { Deferred, Duration, Effect, Fiber, Schema, Scope } from "effect"
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

export const name = "shell"
// How long a foreground command runs before it moves to the background; `experimental.shell_background_after`
// replaces it, a call's `timeout` overrides both.
export const DEFAULT_BACKGROUND_AFTER_MS = 2 * 60 * 1_000
export const listName = "shell_list"
export const readName = "shell_read"
export const killName = "shell_kill"
// The output tail a backgrounded or killed call shows, and what `shell_read` returns without an offset.
const TAIL_LINES = 20
const READ_LINES = 40
const READ_LIMIT = 64 * 1024

const BACKGROUND_INSTRUCTION =
  "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes."
const OS =
  process.platform === "darwin"
    ? "macOS"
    : process.platform === "win32"
      ? "Windows"
      : process.platform === "linux"
        ? "Linux"
        : process.platform
const description = (shell?: string) =>
  [
    "Execute a shell command and return its output.",
    ...(shell ? [`Commands run on ${OS} using ${shell}.`] : []),
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned.",
    "Rely on automatic truncation unless filtering the output is more useful.",
    `A foreground command still running after its timeout (default ${DEFAULT_BACKGROUND_AFTER_MS / 1_000} s) moves to the background: the call returns its shell ID and output so far, and the command keeps running.`,
    "Background commands return immediately, and you will be notified when they complete.",
    `Check a background command with ${readName}, stop it with ${killName}, and see all of this session's commands with ${listName}.`,
  ].join(" ")

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description:
      "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
  }),
  timeout: Schema.optionalKey(NonNegativeInt).annotate({
    description: `Milliseconds. For a foreground command, how long it may run before it moves to the background (it is never killed); 0 waits until it ends. Defaults to ${DEFAULT_BACKGROUND_AFTER_MS}. For a background command, a deadline after which it is killed; none by default.`,
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: `A few words on what the command does, shown when ${listName} lists it.`,
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
  }),
})

const StructuredOutput = Schema.Struct({
  exit: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
  shellID: Schema.optionalKey(Schema.String),
  truncated: Schema.Boolean,
  timeout: Schema.optionalKey(Schema.Boolean),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["completed", "running"])),
  // Set when a foreground command moved to the background: at its time limit, or by the user.
  backgrounded: Schema.optionalKey(Schema.Literals(["limit", "user"])),
})

type Output = typeof Output.Type

const resultMessages = (output: Output) => {
  const notice = output.status === "running" ? BACKGROUND_INSTRUCTION : ShellResult.notice(output)
  return [...(output.output ? [output.output] : []), ...(notice ? [notice] : [])]
}

const toolResult = (output: Output) => {
  return {
    output,
    content: resultMessages(output).map((text) => ({ type: "text" as const, text })),
    metadata: {
      status: output.status,
      ...ShellResult.metadata(output),
      ...(output.shellID !== undefined ? { shellID: output.shellID } : {}),
      ...(output.backgrounded !== undefined ? { backgrounded: output.backgrounded } : {}),
    },
  }
}

const backgroundResult = (shellID: string, file: string) => ({
  output: `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${file}`,
  shellID,
  truncated: false,
  status: "running" as const,
})

// A foreground command that moved to the background, by its time limit or the user: it says so, shows
// the output so far, and names the tools that check on it.
const movedResult = (input: { shellID: string; file: string; seconds: number; tail: string; by: "limit" | "user" }) => ({
  output: [
    input.by === "limit"
      ? `Command is still running after ${input.seconds} s, so it moved to the background (shell ID: ${input.shellID}).`
      : `The user moved the command to the background after ${input.seconds} s (shell ID: ${input.shellID}).`,
    `Output so far (last ${TAIL_LINES} lines):`,
    input.tail || "(no output yet)",
    `Check it with ${readName}({ id: "${input.shellID}" }), stop it with ${killName}({ id: "${input.shellID}" }), or list this session's commands with ${listName}. Output is streaming to: ${input.file}`,
  ].join("\n"),
  shellID: input.shellID,
  truncated: false,
  status: "running" as const,
})

// What a listed or read shell reports. `timeout` is a killed command whose deadline ended it.
type State = "running" | "exited" | "killed"
const stateOf = (info: ShellSchema.Info): State =>
  info.status === "running" ? "running" : info.status === "exited" && info.signal === undefined ? "exited" : "killed"
const runtimeOf = (info: ShellSchema.Info) => (info.time.completed ?? Date.now()) - info.time.started
const shortCommand = (command: string) => {
  const line = command.trim().split("\n")[0] ?? ""
  return line.length > 80 || command.trim().includes("\n") ? `${line.slice(0, 79)}…` : line
}
const describe = (info: ShellSchema.Info) =>
  typeof info.metadata.description === "string" && info.metadata.description !== ""
    ? info.metadata.description
    : shortCommand(info.command)
const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1_000).toFixed(1)} s` : `${Math.round(ms / 1_000)} s`)
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

const IdInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The shell ID a shell call returned, as sh_…" }),
})

const ShellState = {
  id: Schema.String,
  state: Schema.Literals(["running", "exited", "killed"]),
  exit: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
  timedOut: Schema.optionalKey(Schema.Boolean),
  runtime: Schema.Number.annotate({ description: "Milliseconds it ran, or has run so far" }),
  size: Schema.Number.annotate({ description: "Bytes of output it wrote" }),
}

export const ListInput = Schema.Struct({})
const ListOutput = Schema.Struct({
  shells: Schema.Array(
    Schema.Struct({
      ...ShellState,
      description: Schema.String,
      command: Schema.String,
      started: Schema.Number.annotate({ description: "Unix milliseconds" }),
      background: Schema.Boolean,
    }),
  ),
})

export const ReadInput = Schema.Struct({
  id: IdInput.fields.id,
  offset: Schema.optionalKey(NonNegativeInt).annotate({
    description: "Byte offset to read from, as a previous read's `next`. Without it, the read returns the last `lines` lines.",
  }),
  lines: Schema.optionalKey(NonNegativeInt).annotate({
    description: `Without an offset, how many of the last lines to return. Defaults to ${READ_LINES}.`,
  }),
  limit: Schema.optionalKey(NonNegativeInt).annotate({
    description: `Most bytes to return. Defaults to ${READ_LIMIT}.`,
  }),
})
const ReadOutput = Schema.Struct({
  ...ShellState,
  offset: Schema.Number.annotate({ description: "The byte offset the returned text starts at" }),
  next: Schema.Number.annotate({ description: "The byte offset to pass as `offset` to read on" }),
  dropped: Schema.Boolean.annotate({
    description: "Bytes before the returned text are gone: the output outgrew what is kept on disk",
  }),
  output: Schema.String,
})

const KillOutput = Schema.Struct({
  ...ShellState,
  output: Schema.String.annotate({ description: `The last ${TAIL_LINES} lines it wrote` }),
})

const stateFields = (info: ShellSchema.Info, size: number) => ({
  id: info.id,
  state: stateOf(info),
  ...(info.exit !== undefined ? { exit: info.exit } : {}),
  ...(info.signal !== undefined ? { signal: info.signal } : {}),
  ...(info.status === "timeout" ? { timedOut: true } : {}),
  runtime: runtimeOf(info),
  size,
})

const stateLine = (fields: ReturnType<typeof stateFields>) =>
  [
    `${fields.id} ${fields.state}`,
    ...(fields.exit !== undefined ? [`exit ${fields.exit}`] : []),
    ...(fields.signal !== undefined ? [fields.signal] : []),
    ...(fields.timedOut ? ["timed out"] : []),
    seconds(fields.runtime),
    `${fields.size} bytes`,
  ].join(" · ")

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
    // Shells the agent ended with shell_kill: their completion needs no notice, the kill already answered.
    const agentKilled = new Set<string>()

    const backgroundAfter = Effect.fnUntraced(function* (input: typeof Input.Type) {
      if (input.timeout !== undefined) return input.timeout
      return Config.latest(yield* config.entries(), "experimental")?.shell_background_after ?? DEFAULT_BACKGROUND_AFTER_MS
    })

    const tail = Effect.fnUntraced(function* (id: ShellSchema.ID, lines: number) {
      const latest = yield* shell.output(id, { cursor: Number.MAX_SAFE_INTEGER })
      const page = yield* shell.output(id, { cursor: Math.max(0, latest.size - READ_LIMIT), limit: READ_LIMIT })
      return { text: lastLines(page.output, lines).trimEnd(), size: latest.size }
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

    const notifyWhenDone = Effect.fn("ShellTool.notifyWhenDone")(
      function* (
        sessionID: SessionSchema.ID,
        id: string,
        shellID: string,
        command: string,
        settled: Deferred.Deferred<Output>,
      ) {
        const info = (yield* jobs.wait({ id })).info
        if (!info || info.status === "running") return
        if (agentKilled.delete(shellID)) {
          if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
          return
        }
        const output = info.status === "completed" ? yield* Deferred.await(settled) : undefined
        const text = output
          ? resultMessages(output).join("\n\n")
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
            text,
            output,
          }),
        })
        if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
      },
      Effect.forkIn(scope, { startImmediately: true }),
    )

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description: description(),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              // A background call's timeout kills it; a foreground call's moves it to the background.
              const background = input.background === true
              const timeout = background ? (input.timeout ?? 0) : 0
              const limit = background ? 0 : yield* backgroundAfter(input)
              let finalTimeout = timeout
              const info = yield* shell.create(
                {
                  command: input.command,
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

              const settled = yield* Deferred.make<Output>()
              const run = Effect.gen(function* () {
                const result = yield* shell.result(info)
                if (!result.capture) return yield* new Shell.NotFoundError({ id: info.id })
                const output = ShellResult.output(result)
                return {
                  ...output,
                  output: output.timeout
                    ? `${output.output}\n\nCommand exceeded timeout of ${finalTimeout} ms. Retry with a larger timeout if the command is expected to take longer.`
                    : output.output,
                  status: "completed" as const,
                }
              }).pipe(
                Effect.tap((output) => Deferred.succeed(settled, output)),
                Effect.map((output) => resultMessages(output).join("\n\n")),
                Effect.onInterrupt(() => shell.remove(info.id).pipe(Effect.ignore)),
              )
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
                run,
              })

              if (input.background === true) {
                yield* jobs.background(job.id)
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                return backgroundResult(info.id, info.file)
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
                yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                const by = byLimit ? ("limit" as const) : ("user" as const)
                const shown = yield* tail(info.id, TAIL_LINES).pipe(
                  Effect.catchTag("Shell.NotFoundError", () => Effect.succeed({ text: "", size: 0 })),
                )
                return {
                  ...movedResult({
                    shellID: info.id,
                    file: info.file,
                    seconds: Math.round((by === "limit" ? limit : Date.now() - info.time.started) / 1_000),
                    tail: shown.text,
                    by,
                  }),
                  backgrounded: by,
                }
              }
              if (result?.info.status === "error")
                return yield* Effect.fail(new Error(result.info.error ?? "Command failed"))
              if (result?.info.status === "cancelled") return yield* Effect.fail(new Error("Command cancelled"))

              return yield* Deferred.await(settled)
            }).pipe(
              Effect.map(toolResult),
              Effect.mapError(
                (error) => new ToolFailure({ message: `Unable to execute command: ${input.command}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)

    const failure = (message: string) => (error: Error) =>
      new ToolFailure({ message: `${message}: ${error.message}`, error })

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: listName,
          options: { codemode: false },
          description: `List this session's shell commands, running and recently ended: ID, description, state (running, exited, killed), exit code, start, runtime and output size. Read one with ${readName}, stop one with ${killName}.`,
          input: ListInput,
          output: ListOutput,
          execute: (_input, context) =>
            Effect.gen(function* () {
              const infos = (yield* shell.list({ exited: true })).filter(
                (info) => info.metadata.sessionID === context.sessionID,
              )
              const shells = yield* Effect.forEach(infos, (info) =>
                shell.output(info.id, { cursor: Number.MAX_SAFE_INTEGER }).pipe(
                  Effect.map((latest) => latest.size),
                  Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(0)),
                  Effect.map((size) => ({
                    ...stateFields(info, size),
                    description: describe(info),
                    command: shortCommand(info.command),
                    started: info.time.started,
                    background: info.metadata.background === true,
                  })),
                ),
              )
              const text = shells.length
                ? shells.map((item) => `${stateLine(item)} · ${item.description}`).join("\n")
                : "This session has no shell commands."
              return { output: { shells }, content: [{ type: "text" as const, text }] }
            }),
        })
        editor.add({
          name: readName,
          options: { codemode: false },
          description: `Read a shell command's output and state by its shell ID: the last ${READ_LINES} lines by default, or from a byte offset (a previous read's \`next\`) to follow it. Only this session's shells. Output is kept on disk up to about ${(2 * Shell.OUTPUT_SEGMENT_BYTES) / 1024 / 1024} MiB per command; past that the oldest bytes are dropped.`,
          input: ReadInput,
          output: ReadOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              const info = yield* own(input.id, context)
              const limit = input.limit ?? READ_LIMIT
              const latest = yield* shell.output(info.id, { cursor: Number.MAX_SAFE_INTEGER })
              const fromEnd = input.offset === undefined
              const page = yield* shell.output(info.id, {
                cursor: fromEnd ? Math.max(0, latest.size - limit) : input.offset,
                limit,
              })
              const text = fromEnd ? lastLines(page.output, input.lines ?? READ_LINES) : page.output
              const offset = page.cursor - Buffer.byteLength(text)
              const current = yield* shell.get(info.id)
              const output = {
                ...stateFields(current, page.size),
                offset,
                next: page.cursor,
                dropped: page.truncated,
                output: text,
              }
              const header = `${stateLine(output)} · bytes ${offset}-${page.cursor}${output.dropped ? " · earlier output was dropped" : ""}`
              return {
                output,
                content: [{ type: "text" as const, text: `${header}\n${text || "(no output)"}` }],
              }
            }).pipe(Effect.mapError(failure(`Unable to read shell ${input.id}`))),
        })
        editor.add({
          name: killName,
          options: { codemode: false },
          description: `Stop one of this session's shell commands by its shell ID: SIGTERM to its process group, then SIGKILL to whatever is left after ${Duration.toSeconds(Shell.KILL_GRACE)} s. Returns its final state and last ${TAIL_LINES} lines. A command that already ended is left as it is. No completion notice follows a kill made here.`,
          input: IdInput,
          output: KillOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              const info = yield* own(input.id, context)
              if (info.status === "running") agentKilled.add(info.id)
              const ended = yield* shell.kill(info.id)
              const shown = yield* tail(info.id, TAIL_LINES)
              const output = { ...stateFields(ended, shown.size), output: shown.text }
              const verb = info.status === "running" ? "Killed" : "Already ended"
              return {
                output,
                content: [
                  { type: "text" as const, text: `${verb}: ${stateLine(output)}\n${shown.text || "(no output)"}` },
                ],
              }
            }).pipe(Effect.mapError(failure(`Unable to kill shell ${input.id}`))),
        })
      })
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
