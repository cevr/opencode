// Moving an open TUI onto the build an install put in place. An install records its build in `<state>/installed.json`
// (@opencode/util/installed-build) and restarts the background service onto it, while every TUI already open keeps the
// build it started with. A TUI attached to the managed service reads the service's build each time its event stream
// connects. It moves only when the service runs the installed build, from the installed command, and that build
// superseded the TUI's own (the install lists the TUI's build among those it replaced): never on a mere difference,
// so a service some older client started never pulls a TUI back.
//
// It waits for a quiet moment: no input for `update.idle` seconds (any key or paste, seen before any component can
// consume it, a mouse press or scroll, or a change to a composer's text or cursor), no dialog open, no form answer
// begun, and the session on screen idle at its root (a subagent still running under it does not hold the move: it
// carries on as after an interruption). It then says so in a one-line notice, checks again when the notice ends (any of those withdraws it), checks
// that the installed build still runs, and asks its caller to replace the process with that build on the same
// session. The composer drafts go along in a handoff file under the state directory, whose path the next process
// reads from OPENCODE_TUI_HANDOFF. When the move fails, the caller starts this build again with the same handoff and
// OPENCODE_TUI_STAYED naming the build that failed, which this process then never tries again.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { createEffect, createSignal, on, onCleanup, onMount, untrack } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { InstalledBuild } from "@opencode/util/installed-build"
import { useClient } from "./client"
import { useData, type FormWithLocation } from "./data"
import { useExit } from "./exit"
import { useRoute } from "./route"
import { useTuiApp, useTuiPaths } from "./runtime"
import { useConfig } from "../config"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { allDrafts, saveDraft, type DraftEntry } from "../component/prompt/draft-stash"
import { parsePromptInfo } from "../prompt/history"
import { formAnswerBegun } from "../routes/session/form"

/** The variable that names the handoff file to the process that replaces this one. */
export const HANDOFF_ENV = "OPENCODE_TUI_HANDOFF"
/** The variable that names the build a failed move tried, which the TUI then stays off. */
export const STAYED_ENV = "OPENCODE_TUI_STAYED"
/** How long the notice shows before the restart; input meanwhile withdraws it. */
export const NOTICE_MS = 3_000
export const DEFAULT_IDLE_SECONDS = 10
/** A handoff older than this was left by a move that never arrived. */
const STALE_HANDOFF_MS = 10 * 60_000
/** The waits between tries of a service read that failed (a service still starting answers 503). */
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const
const CHECK_MS = 500
// A mouse press, release or wheel turn in the SGR encoding the renderer asks for (after its ESC); motion alone (bit
// 32) is not input. Typed text that looks like one is input all the same.
const MOUSE = /\[<(\d+);\d+;\d+[Mm]/g

/**
 * What replaces this process: the installed build's command with `args`, and `env` added to this process's
 * environment; `stay` is the environment this build starts again with when the move fails.
 */
export type RestartPlan = {
  readonly command: ReadonlyArray<string>
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly stay: Readonly<Record<string, string>>
  readonly handoff: string
  readonly version: string
}

/** The exit reason that asks `run`'s caller to replace the process by `plan`. */
export class RestartOnto {
  readonly _tag = "RestartOnto"
  constructor(readonly plan: RestartPlan) {}
}

const core = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** The installed build a TUI on build `own` moves onto, given what the service reports: undefined when it stays. */
export function moveTarget(
  own: string,
  served: { readonly version: string; readonly command?: ReadonlyArray<string> },
  installed: InstalledBuild.Info | undefined,
) {
  if (!InstalledBuild.supersedes(installed, own)) return undefined
  if (served.version !== installed.version) return undefined
  if (JSON.stringify(served.command ?? []) !== JSON.stringify(installed.command)) return undefined
  // A release number never goes back, whatever the record says.
  const [ours, theirs] = [core(own), core(installed.version)]
  if (ours && theirs)
    for (let index = 0; index < 3; index++) {
      if (theirs[index]! > ours[index]!) break
      if (theirs[index]! < ours[index]!) return undefined
    }
  return { version: installed.version, command: installed.command }
}

const Handoff = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  drafts: Schema.Array(
    Schema.Struct({
      sessionID: Schema.NullOr(Schema.String),
      prompt: Schema.Unknown,
      // Null for a cursor at the end (JSON has no Infinity).
      cursor: Schema.NullOr(Schema.Number),
    }),
  ),
})
type Handoff = typeof Handoff.Type
const decodeHandoff = Schema.decodeUnknownOption(Schema.fromJsonString(Handoff))

const handoffDir = (state: string) => path.join(state, "tui-handoff")

/** Writes the drafts for the next process to `<state>/tui-handoff/<pid>.json`, readable by this user alone. */
export function writeHandoff(
  state: string,
  handoff: { from: string; to: string; drafts: ReadonlyArray<[string | undefined, DraftEntry]> },
) {
  const file = path.join(handoffDir(state), `${process.pid}.json`)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const body: Handoff = {
    from: handoff.from,
    to: handoff.to,
    drafts: handoff.drafts.map(([sessionID, entry]) => ({
      sessionID: sessionID ?? null,
      prompt: entry.prompt,
      cursor: Number.isFinite(entry.cursor) ? entry.cursor : null,
    })),
  }
  writeFileSync(file, JSON.stringify(body), { mode: 0o600 })
  return file
}

export type Arrival = { readonly from: string; readonly to: string; readonly stayed: boolean }
let arrival: Arrival | undefined
/** The builds a move onto failed, which this process does not try again. */
const stayedOff = new Set<string>()

/**
 * Takes the handoff a replaced TUI left for this one, if `env` names one: stashes its drafts for the composers that
 * mount next, deletes the file and the variables (so nothing this process starts inherits them), and returns the
 * builds it moved between, or the build it stayed off. Deletes handoffs under `state` that no process took.
 */
export function arrive(env: Record<string, string | undefined> = process.env, state?: string) {
  if (state) sweep(state)
  const file = env[HANDOFF_ENV]
  const stayed = env[STAYED_ENV]
  delete env[HANDOFF_ENV]
  delete env[STAYED_ENV]
  if (stayed) stayedOff.add(stayed)
  if (!file) return undefined
  const text = (() => {
    try {
      return readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  })()
  rmSync(file, { force: true })
  const handoff = text === undefined ? undefined : Option.getOrUndefined(decodeHandoff(text))
  if (!handoff) return undefined
  for (const draft of handoff.drafts) {
    const prompt = parsePromptInfo(draft.prompt)
    if (prompt) saveDraft(draft.sessionID ?? undefined, { prompt, cursor: draft.cursor ?? Infinity })
  }
  arrival = { from: handoff.from, to: handoff.to, stayed: stayed === handoff.to }
  return arrival
}

function sweep(state: string) {
  const dir = handoffDir(state)
  const names = (() => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  })()
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      if (Date.now() - statSync(file).mtimeMs > STALE_HANDOFF_MS) rmSync(file, { force: true })
    } catch {
      // Taken meanwhile.
    }
  }
}

/** Runs the move onto the installed build for the App; nothing without a managed service or with it off. */
export function useUpdateRestart() {
  const client = useClient()
  const config = useConfig()
  const app = useTuiApp()
  const route = useRoute()
  const dialog = useDialog()
  const renderer = useRenderer()
  const toast = useToast()
  const exit = useExit()
  const data = useData()
  const paths = useTuiPaths()

  onMount(() => {
    const moved = arrival
    arrival = undefined
    if (!moved) return
    if (moved.stayed)
      toast.show({
        variant: "warning",
        message: `OpenCode ${moved.to} did not start: staying on ${moved.from}`,
        duration: 6_000,
      })
    else
      toast.show({ variant: "info", message: `OpenCode moved onto ${moved.to} (from ${moved.from})`, duration: 4_000 })
  })
  if (!client.restart) return

  const enabled = () => config.data.update?.restart !== false
  // Input, counted where it arrives: a component that consumes a key (the composer's arrows, backspace, escape) stops
  // listeners registered after it, so this one goes first.
  let inputAt = performance.now()
  const touch = () => {
    inputAt = performance.now()
  }
  const mouse = (chunk: Buffer | string) => {
    for (const match of chunk.toString().matchAll(MOUSE)) if ((Number(match[1]) & 32) === 0) return touch()
  }
  renderer.keyInput.prependListener("keypress", touch)
  renderer.keyInput.prependListener("paste", touch)
  renderer.stdin.on("data", mouse)
  onCleanup(() => {
    renderer.keyInput.off("keypress", touch)
    renderer.keyInput.off("paste", touch)
    renderer.stdin.off("data", mouse)
  })
  // A composer whose text or cursor moved counts as input too, however it moved.
  let composers = ""
  const watchComposers = () => {
    const now = JSON.stringify(allDrafts())
    if (now !== composers) touch()
    composers = now
  }

  const [target, setTarget] = createSignal<{ readonly version: string; readonly command: ReadonlyArray<string> }>()
  // A read the next connection started is newer, so each read takes a turn and an older one's answer is dropped.
  let turn = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  const read = (current: number, tries: number) => {
    void client.api.server.info().then(
      async (info) => {
        const next = moveTarget(app.version, info, InstalledBuild.read(paths.state))
        if (turn !== current || !next || stayedOff.has(next.version)) return
        if (!(await reports(next.command, next.version)) || turn !== current) return
        setTarget(next)
      },
      () => {
        const wait = RETRY_MS[tries]
        if (turn !== current || wait === undefined) return
        retry = setTimeout(() => read(current, tries + 1), wait)
      },
    )
  }
  createEffect(
    on(
      () => client.connection.status() === "connected",
      (connected) => {
        clearTimeout(retry)
        turn++
        if (connected) read(turn, 0)
      },
    ),
  )
  onCleanup(() => {
    turn++
    clearTimeout(retry)
  })

  const pending = (form: FormWithLocation) =>
    data.session.form.list(form.sessionID, form.location)?.some((item) => item.id === form.id) ?? false
  // The session on screen is mid-turn: its root session runs (the model answering) or holds a prompt queued to run.
  // A subagent running under an idle root does not count: it picks up where it left off, as after an interruption.
  const turning = () => {
    if (route.data.type !== "session") return false
    let root = route.data.sessionID
    for (let depth = 0; depth < 32; depth++) {
      const parent = data.session.get(root)?.parentID
      if (!parent) break
      root = parent
    }
    return (
      data.session.status(root) === "running" ||
      data.session.pending.list(root).some((item) => item.type !== "synthetic")
    )
  }
  const busy = () => dialog.stack.length > 0 || formAnswerBegun(pending) || turning()
  const idle = () => performance.now() - inputAt >= (config.data.update?.idle ?? DEFAULT_IDLE_SECONDS) * 1_000

  createEffect(() => {
    const next = target()
    if (!next || !enabled()) return
    // When the notice went up.
    let noticed: number | undefined
    let checking = false
    // Untracked: the composers' text is a store, and an edit must not restart this effect (and its notice).
    composers = untrack(() => JSON.stringify(allDrafts()))
    const timer = setInterval(() => {
      if (renderer.isDestroyed || checking) return
      watchComposers()
      if (noticed === undefined) {
        if (!idle() || busy()) return
        noticed = performance.now()
        toast.show({
          variant: "info",
          message: `OpenCode ${next.version} is installed: restarting onto it, on this session with your draft`,
          duration: NOTICE_MS,
        })
        return
      }
      if (performance.now() - noticed < NOTICE_MS) return
      // The build may have gone since it was found: it is checked again as the move starts. Input during the notice, a
      // dialog or a form answer then takes the notice back, and a whole new one has to pass.
      checking = true
      const since = noticed
      void reports(next.command, next.version).then((runs) => {
        checking = false
        if (renderer.isDestroyed) return
        if (!runs) {
          clearInterval(timer)
          stayedOff.add(next.version)
          setTarget(undefined)
          return
        }
        watchComposers()
        if (inputAt > since || busy()) {
          noticed = undefined
          return
        }
        clearInterval(timer)
        const sessionID =
          route.data.type === "session" && route.data.sessionID !== "dummy" ? route.data.sessionID : undefined
        const file = writeHandoff(paths.state, { from: app.version, to: next.version, drafts: allDrafts() })
        exit(
          new RestartOnto({
            command: next.command,
            args: sessionID ? ["-s", sessionID] : [],
            env: { [HANDOFF_ENV]: file },
            stay: { [HANDOFF_ENV]: file, [STAYED_ENV]: next.version },
            handoff: file,
            version: next.version,
          }),
        )
      })
    }, CHECK_MS)
    onCleanup(() => clearInterval(timer))
  })
}

/** Whether `command --version` reports `version`: the build is in place and runs. */
async function reports(command: ReadonlyArray<string>, version: string) {
  try {
    const child = Bun.spawn([...command, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const timer = setTimeout(() => child.kill(), 10_000)
    const output = await new Response(child.stdout).text()
    clearTimeout(timer)
    return (await child.exited) === 0 && output.trim().split(/\s+/).includes(version)
  } catch {
    return false
  }
}
