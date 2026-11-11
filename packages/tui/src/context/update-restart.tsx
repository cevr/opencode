// Moving an open TUI onto the build an install put in place. An install restarts the background service onto its new
// build, while every TUI already open keeps the build it started with. A TUI attached to the managed service reads
// the service's build each time its event stream connects; once the service runs a newer one, it waits for a quiet
// moment (no key pressed for `update.idle` seconds, no dialog open, no form answer begun), says so in a one-line notice,
// and asks its caller to replace the process with the service's own command (`/api/info` `command`) on the same
// session. The composer drafts go along in a handoff file under the state directory, named by the process id (the
// replaced process keeps it), whose path the next process reads from OPENCODE_TUI_HANDOFF.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { useRenderer } from "@opentui/solid"
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
/** How long the notice shows before the restart; a key pressed meanwhile holds it. */
export const NOTICE_MS = 3_000
export const DEFAULT_IDLE_SECONDS = 10
/** The waits between tries of a service read that failed (a service still starting answers 503). */
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const
const CHECK_MS = 500

/** What replaces this process: the service's command with `args`, and `env` added to this process's environment. */
export type RestartPlan = {
  readonly command: ReadonlyArray<string>
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
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

/**
 * Whether a TUI on build `own` moves onto the service's build `served`: it differs, it is a build (not `unknown` or a
 * source run's `local`), and its release is not older. Builds of one release (`2.2.7-prime.<commit>`) carry no order
 * among themselves; the service only moves to one through an install, so a different one is the newer.
 */
export function movesForward(own: string, served: string) {
  if (served === own || served === "unknown" || served === "local" || own === "local") return false
  const [ours, theirs] = [core(own), core(served)]
  if (!ours || !theirs) return true
  for (let index = 0; index < 3; index++) if (theirs[index] !== ours[index]) return theirs[index]! > ours[index]!
  return true
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

/** Writes the drafts for the next process to `<state>/tui-handoff/<pid>.json`, readable by this user alone. */
export function writeHandoff(
  state: string,
  handoff: { from: string; to: string; drafts: ReadonlyArray<[string | undefined, DraftEntry]> },
) {
  const file = path.join(state, "tui-handoff", `${process.pid}.json`)
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

let arrived: { readonly from: string; readonly to: string } | undefined

/**
 * Takes the handoff a replaced TUI left for this one, if `env` names one: stashes its drafts for the composers that
 * mount next, deletes the file and the variable (so nothing this process starts inherits it), and returns the builds
 * it moved between.
 */
export function arrive(env: Record<string, string | undefined> = process.env) {
  const file = env[HANDOFF_ENV]
  if (!file) return undefined
  delete env[HANDOFF_ENV]
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
  arrived = { from: handoff.from, to: handoff.to }
  return arrived
}

/** Runs the move onto the service's newer build for the App; nothing without a managed service or with it off. */
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
    const moved = arrived
    arrived = undefined
    if (moved)
      toast.show({ variant: "info", message: `OpenCode moved onto ${moved.to} (from ${moved.from})`, duration: 4_000 })
  })
  if (!client.restart) return

  const enabled = () => config.data.update?.restart !== false
  let keyed = performance.now()
  const touch = () => {
    keyed = performance.now()
  }
  renderer.keyInput.on("keypress", touch)
  renderer.keyInput.on("paste", touch)
  onCleanup(() => {
    renderer.keyInput.off("keypress", touch)
    renderer.keyInput.off("paste", touch)
  })

  const [target, setTarget] = createSignal<{ readonly version: string; readonly command: ReadonlyArray<string> }>()
  // A read the next connection started is newer, so each read takes a turn and an older one's answer is dropped.
  let turn = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  const read = (current: number, tries: number) => {
    void client.api.server.info().then(
      async (info) => {
        if (turn !== current || !movesForward(app.version, info.version) || !info.command?.length) return
        if (!(await reports(info.command, info.version)) || turn !== current) return
        setTarget({ version: info.version, command: info.command })
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
  const quiet = () =>
    performance.now() - keyed >= (config.data.update?.idle ?? DEFAULT_IDLE_SECONDS) * 1_000 &&
    dialog.stack.length === 0 &&
    !formAnswerBegun(pending)

  createEffect(() => {
    const next = target()
    if (!next || !enabled()) return
    // When the notice went up; a key pressed since, a dialog opened or a form answer begun takes it back.
    let noticed: number | undefined
    const timer = setInterval(() => {
      if (renderer.isDestroyed) return
      if (noticed === undefined) {
        if (!quiet()) return
        noticed = performance.now()
        toast.show({
          variant: "info",
          message: `OpenCode ${next.version} is installed: restarting onto it, on this session with your draft`,
          duration: NOTICE_MS,
        })
        return
      }
      if (keyed > noticed || dialog.stack.length > 0 || formAnswerBegun(pending)) {
        noticed = undefined
        return
      }
      if (performance.now() - noticed < NOTICE_MS) return
      clearInterval(timer)
      const sessionID =
        route.data.type === "session" && route.data.sessionID !== "dummy" ? route.data.sessionID : undefined
      const file = writeHandoff(paths.state, { from: app.version, to: next.version, drafts: allDrafts() })
      exit(
        new RestartOnto({
          command: next.command,
          args: sessionID ? ["-s", sessionID] : [],
          env: { [HANDOFF_ENV]: file },
          version: next.version,
        }),
      )
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
    return (await child.exited) === 0 && output.includes(version)
  } catch {
    return false
  }
}
