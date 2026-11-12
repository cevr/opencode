import { expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import {
  arrive,
  HANDOFF_ENV,
  moveTarget,
  namesVersion,
  NOTICE_MS,
  reports,
  settle,
  STAYED_ENV,
  writeHandoff,
  type RestartPlan,
} from "../src/context/update-restart"
import { appendToSessionPrompt, takeDraft } from "../src/component/prompt/draft-stash"

// The moves wait out an idle time and a notice, and the TUI boots twice.
setDefaultTimeout(60_000)

const OLD = "2.2.5-prime.5cd5a2b9"
const NEW = "2.2.7-prime.13a38089"
const NOTICE = `OpenCode ${NEW} is installed`

const session = {
  id: "ses_reexec",
  projectID: "proj_test",
  location: { directory },
  title: "Reexec session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

const child = { ...session, id: "ses_reexec_child", parentID: session.id, title: "Subagent" }

const form = {
  id: "frm_reexec",
  sessionID: session.id,
  title: "Pick a target",
  fields: [{ key: "targets", type: "multiselect", options: [{ value: "staging", label: "Staging" }], custom: true }],
}

// The CLI from source, built as a release would be with OPENCODE_VERSION set, so `--version` prints what an installed
// build prints, through the CLI's own code.
const CLI = path.resolve(import.meta.dir, "../../cli/src/index.ts")
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** An executable at `file` that runs the CLI as build `version`, with its state under `dir`. */
function build(file: string, version: string, dir: string) {
  const env = ["DATA", "STATE", "CONFIG", "CACHE"].map((name) => `${name}_HOME=${quote(path.join(dir, "xdg", name))}`)
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      ...env.map((assignment) => `export XDG_${assignment}`),
      `exec ${quote(process.execPath)} --define ${quote(`OPENCODE_VERSION=${JSON.stringify(version)}`)} ${quote(CLI)} "$@"`,
      "",
    ].join("\n"),
  )
  chmodSync(file, 0o755)
}

/**
 * A machine with an install: the installed build's command (the CLI as build `reports`), its record in the state
 * directory listing the builds it replaced, and a fake service whose build the install moves.
 */
async function machine(
  dir: string,
  input: { reports?: string; previous?: ReadonlyArray<string>; servedCommand?: string; form?: boolean } = {},
) {
  const state = path.join(dir, "state")
  const command = path.join(dir, "opencode-new")
  build(command, input.reports ?? NEW, dir)
  mkdirSync(state, { recursive: true })
  writeFileSync(
    path.join(state, "installed.json"),
    JSON.stringify({ version: NEW, command: [command], previous: input.previous ?? [OLD] }),
  )
  // `active`: the sessions whose turn runs, as the service reports them on each connection.
  const service = { served: OLD, active: [] as string[] }
  const fetch = (url: URL) => {
    if (url.pathname === "/api/session/active")
      return json({ data: Object.fromEntries(service.active.map((id) => [id, { type: "running" }])) })
    if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
    if (url.pathname === `/api/session/${session.id}/family/request`)
      return json({ data: { sessions: [session.id, child.id], permissions: [], forms: [] } })
    if (url.pathname === "/api/info")
      return json({
        version: service.served,
        pid: 1,
        urls: [],
        command: [input.servedCommand ?? command],
        paths: { tmp: "/tmp" },
      })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`)
      return json({
        data: [{ id: "msg_reexec_user", type: "user", text: "Earlier question", time: { created: 1 } }],
        cursor: {},
      })
    if (url.pathname === `/api/session/${session.id}/form`) return json({ data: input.form ? [form] : [] })
    if ([`/api/session/${session.id}/inbox`, `/api/session/${session.id}/permission`].includes(url.pathname))
      return json({ data: [] })
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    return undefined
  }
  return { state, command, service, fetch }
}

type Machine = Awaited<ReturnType<typeof machine>>

async function oldTui(fake: Machine, update: { idle?: number; restart?: boolean } = { idle: 0 }) {
  const tui = await createAppFixture({
    state: fake.state,
    version: OLD,
    managed: true,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" }, update },
    fetch: fake.fetch,
  })
  await tui.ready
  await tui.waitForFrame((frame) => frame.includes("Earlier question") || frame.includes(form.title))
  return tui
}

/** The install: the service restarts on the new build and the TUI's event stream reconnects to it. */
function install(fake: Machine, tui: Awaited<ReturnType<typeof oldTui>>) {
  fake.service.served = NEW
  tui.events.disconnect()
}

const settled = <T,>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, Bun.sleep(ms).then(() => "pending" as const)])

// The installed build's `--version` runs the CLI, which takes most of a second before the notice can show.
/** Whether the notice shows at any moment over `ms`. */
async function noticeWithin(tui: Awaited<ReturnType<typeof oldTui>>, ms: number) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    if (tui.captureCharFrame().includes(NOTICE)) return true
    await Bun.sleep(50)
  }
  return false
}

test("an old TUI on a session moves onto the installed build, on the same session with its draft", async () => {
  await using scratch = await tmpdir()
  const fake = await machine(scratch.path)
  await using old = await oldTui(fake)
  await old.mockInput.typeText("Carry this draft")
  await old.waitForFrame((frame) => frame.includes("Carry this draft"))

  install(fake, old)
  expect(await noticeWithin(old, 15_000)).toBe(true)
  const result = (await settled(old.task, 15_000)) as { restart?: RestartPlan } | "pending"
  expect(result).not.toBe("pending")
  const plan = (result as { restart?: RestartPlan }).restart!
  expect(plan.command).toEqual([fake.command])
  expect(plan.args).toEqual(["-s", session.id])
  const file = plan.env[HANDOFF_ENV]!
  expect(path.dirname(file)).toBe(path.join(fake.state, "tui-handoff"))
  // A move that fails starts this build again with the same drafts, told to stay off the new one.
  expect(plan.stay).toEqual({ [HANDOFF_ENV]: file, [STAYED_ENV]: NEW })
  expect(plan.handoff).toBe(file)

  // The next process starts on the session with the handoff named, as `-s` and the environment give it.
  process.env[HANDOFF_ENV] = file
  await using next = await createAppFixture({
    state: fake.state,
    version: NEW,
    managed: true,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: fake.fetch,
  })
  await next.ready
  await next.waitForFrame((frame) => frame.includes("Earlier question") && frame.includes("Carry this draft"))
  await next.waitForFrame((frame) => frame.includes(`OpenCode moved onto ${NEW}`))
  expect(process.env[HANDOFF_ENV]).toBeUndefined()
  expect(existsSync(file)).toBe(false)
  // It runs the installed build: it stays.
  expect(await settled(next.task, 1_500)).toBe("pending")
})

// Every kind of input the owner gives while editing, each repeated faster than the idle time and alone, so each must
// count on its own. Arrows, backspace, escape and the line keys are consumed by the composer before any late listener.
const inputs: Array<[string, (tui: Awaited<ReturnType<typeof oldTui>>) => void | Promise<void>]> = [
  ["left", (tui) => tui.mockInput.pressArrow("left")],
  ["right", (tui) => tui.mockInput.pressArrow("right")],
  ["up", (tui) => tui.mockInput.pressArrow("up")],
  ["backspace", (tui) => tui.mockInput.pressBackspace()],
  ["ctrl+a", (tui) => tui.mockInput.pressKey("a", { ctrl: true })],
  ["ctrl+e", (tui) => tui.mockInput.pressKey("e", { ctrl: true })],
  ["escape", (tui) => tui.mockInput.pressEscape()],
  ["home", (tui) => tui.mockInput.pressKey("HOME")],
  ["delete", (tui) => tui.mockInput.pressKey("DELETE")],
  ["letter", (tui) => tui.mockInput.typeText("x")],
  ["paste", (tui) => tui.mockInput.pasteBracketedText("y")],
  ["mouse wheel", (tui) => tui.mockMouse.scroll(10, 5, "up")],
  // An edit no key made: an undo's text coming back, a plugin writing to the composer.
  [
    "composer edit",
    () =>
      void appendToSessionPrompt(session.id, { text: "z", files: [], agents: [], skills: [], pasted: [] }, "wcwidth"),
  ],
]

test("any input, whichever component consumes it, holds the move; it goes once the input stops", async () => {
  await using scratch = await tmpdir()
  const fake = await machine(scratch.path)
  await using old = await oldTui(fake, { idle: 1 })
  await old.mockInput.typeText("Draft to edit")
  install(fake, old)
  for (const [name, press] of inputs) {
    const end = performance.now() + 2_000
    let shown = false
    while (performance.now() < end) {
      await press(old)
      for (let wait = 0; wait < 6 && !shown; wait++) {
        shown = old.captureCharFrame().includes(NOTICE)
        await Bun.sleep(50)
      }
    }
    expect({ input: name, notice: shown }).toEqual({ input: name, notice: false })
    expect({ input: name, moved: await settled(old.task, 0) }).toEqual({ input: name, moved: "pending" })
  }
  expect(await settled(old.task, 10_000)).not.toBe("pending")
})

test("an open dialog holds the move, and it goes once the dialog closes", async () => {
  await using scratch = await tmpdir()
  const fake = await machine(scratch.path)
  await using old = await oldTui(fake)
  old.mockInput.pressKey("p", { ctrl: true })
  await old.waitForFrame((frame) => frame.includes("Commands"))
  install(fake, old)
  expect(await noticeWithin(old, 5_000)).toBe(false)
  expect(await settled(old.task, 0)).toBe("pending")
  old.mockInput.pressEscape()
  expect(await settled(old.task, 10_000)).not.toBe("pending")
})

test("a form answer begun holds the move", async () => {
  await using scratch = await tmpdir()
  const fake = await machine(scratch.path, { form: true })
  await using old = await oldTui(fake)
  await old.waitForFrame((frame) => frame.includes(form.title))
  old.mockInput.pressArrow("down")
  await old.mockInput.typeText("prod")
  await old.waitForFrame((frame) => frame.includes("[✓] prod"))
  install(fake, old)
  expect(await noticeWithin(old, 6_000)).toBe(false)
  expect(await settled(old.task, 0)).toBe("pending")
})

test("the session's root turn holds the move; a subagent still running under it does not", async () => {
  await using scratch = await tmpdir()
  const fake = await machine(scratch.path)
  await using old = await oldTui(fake)
  fake.service.active = [session.id, child.id]
  install(fake, old)
  expect(await noticeWithin(old, 5_000)).toBe(false)
  expect(await settled(old.task, 0)).toBe("pending")
  // The root's turn ends while its subagent runs on; the next connection reads that.
  fake.service.active = [child.id]
  old.events.disconnect()
  expect(await settled(old.task, 10_000)).not.toBe("pending")
})

test("input during the notice withdraws it: the move waits a whole notice after the input", async () => {
  await using scratch = await tmpdir()
  const fake = await machine(scratch.path)
  await using old = await oldTui(fake)
  install(fake, old)
  expect(await noticeWithin(old, 15_000)).toBe(true)
  await Bun.sleep(1_000)
  old.mockInput.pressArrow("left")
  const pressed = performance.now()
  expect(await settled(old.task, 15_000)).not.toBe("pending")
  expect(performance.now() - pressed).toBeGreaterThanOrEqual(NOTICE_MS)
})

test("the off switch keeps the TUI on its build", async () => {
  await using scratch = await tmpdir()
  const fake = await machine(scratch.path)
  await using old = await oldTui(fake, { restart: false, idle: 0 })
  install(fake, old)
  expect(await noticeWithin(old, 4_000)).toBe(false)
  expect(await settled(old.task, 0)).toBe("pending")
})

test("a TUI without a managed service never moves", async () => {
  await using scratch = await tmpdir()
  const fake = await machine(scratch.path)
  fake.service.served = NEW
  await using old = await createAppFixture({
    state: fake.state,
    version: OLD,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" }, update: { idle: 0 } },
    fetch: fake.fetch,
  })
  await old.ready
  await old.waitForFrame((frame) => frame.includes("Earlier question"))
  expect(await settled(old.task, 4_000)).toBe("pending")
})

for (const [name, input] of [
  ["whose command reports another version", { reports: "2.2.7-prime.ffffffff" }],
  ["that did not supersede the TUI's build", { previous: ["2.2.4"] }],
  ["that the service does not run from the installed command", { servedCommand: "/nonexistent/loop-probe-x" }],
] as const) {
  test(`a TUI stays off an installed build ${name}`, async () => {
    await using scratch = await tmpdir()
    const fake = await machine(scratch.path, input)
    await using old = await oldTui(fake)
    install(fake, old)
    expect(await noticeWithin(old, 4_000)).toBe(false)
    expect(await settled(old.task, 0)).toBe("pending")
  })
}

test("an installed build gone when the notice ends leaves the TUI on its build, and it is not tried again", async () => {
  await using scratch = await tmpdir()
  const fake = await machine(scratch.path)
  await using old = await oldTui(fake)
  install(fake, old)
  expect(await noticeWithin(old, 15_000)).toBe(true)
  const script = readFileSync(fake.command, "utf8")
  rmSync(fake.command)
  expect(await settled(old.task, NOTICE_MS + 3_000)).toBe("pending")
  // Back in place and found again on the next connection: the TUI stays off it all the same.
  writeFileSync(fake.command, script, { mode: 0o755 })
  await Bun.sleep(NOTICE_MS)
  old.events.disconnect()
  expect(await noticeWithin(old, 4_000)).toBe(false)
  expect(await settled(old.task, 0)).toBe("pending")
})

test("a build's version is read from what the CLI's --version prints", async () => {
  await using scratch = await tmpdir()
  const file = path.join(scratch.path, "opencode-new")
  build(file, NEW, scratch.path)
  // The real output, `opencode v<version>`, from the CLI's own code.
  const printed = await new Response(Bun.spawn([file, "--version"], { stdout: "pipe" }).stdout).text()
  expect(printed.trim()).toBe(`opencode v${NEW}`)
  expect(await reports([file], NEW)).toBe(true)
  expect(await reports([file], OLD)).toBe(false)
  expect(namesVersion(`opencode v${NEW}\n`, NEW)).toBe(true)
  expect(namesVersion(NEW, NEW)).toBe(true)
  expect(namesVersion(`opencode v${NEW}-dirty`, NEW)).toBe(false)
})

test("a TUI moves only onto the installed build the service runs, from a build it superseded, never back", () => {
  const installed = { version: NEW, command: ["/opt/opencode-new"], previous: [OLD, "2.2.7-prime.aaaaaaaa"] } as const
  const served = { version: NEW, command: ["/opt/opencode-new"] }
  expect(moveTarget(OLD, served, installed)).toEqual({ version: NEW, command: ["/opt/opencode-new"] })
  expect(moveTarget("2.2.7-prime.aaaaaaaa", served, installed)?.version).toBe(NEW)
  // A mere difference is no move: a build the record does not list, or no record at all.
  expect(moveTarget("2.2.7-prime.bbbbbbbb", served, installed)).toBeUndefined()
  expect(moveTarget(OLD, served, undefined)).toBeUndefined()
  // The service on another build than the installed one, or started from another command (an older client's).
  expect(moveTarget(OLD, { version: OLD, command: ["/opt/opencode-new"] }, installed)).toBeUndefined()
  expect(moveTarget(OLD, { version: NEW, command: ["/opt/opencode-old"] }, installed)).toBeUndefined()
  expect(moveTarget(OLD, { version: NEW }, installed)).toBeUndefined()
  // The installed build itself, and a record that lists a later release as replaced.
  expect(moveTarget(NEW, served, installed)).toBeUndefined()
  expect(moveTarget("2.3.0", served, { ...installed, previous: ["2.3.0"] })).toBeUndefined()
})

test("the handoff carries every tab's draft, is kept until the screen is up, and handoffs nobody took are swept", async () => {
  await using scratch = await tmpdir()
  const prompt = (text: string) => ({ text, files: [], agents: [], skills: [], pasted: [] })
  const file = writeHandoff(scratch.path, {
    from: OLD,
    to: NEW,
    drafts: [
      ["ses_a", { prompt: prompt("on a"), cursor: 2 }],
      [undefined, { prompt: prompt("on home"), cursor: Infinity }],
    ],
  })
  expect((await Bun.file(file).stat()).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(file, "utf8")).drafts).toHaveLength(2)
  const env: Record<string, string | undefined> = { [HANDOFF_ENV]: file }
  expect(arrive(env)).toEqual({ from: OLD, to: NEW, stayed: false })
  expect(env[HANDOFF_ENV]).toBeUndefined()
  // The file stays until the screen is up: a watcher that finds it after this process ended starts the build before.
  expect(existsSync(file)).toBe(true)
  settle()
  expect(existsSync(file)).toBe(false)
  expect(takeDraft("ses_a")).toEqual({ prompt: prompt("on a"), cursor: 2 })
  expect(takeDraft(undefined)).toEqual({ prompt: prompt("on home"), cursor: Infinity })
  expect(arrive({ [HANDOFF_ENV]: file })).toBeUndefined()

  // Started again on its own build after a failed move: the same drafts, and the build it stays off.
  const again = writeHandoff(scratch.path, { from: OLD, to: NEW, drafts: [] })
  const stayed: Record<string, string | undefined> = { [HANDOFF_ENV]: again, [STAYED_ENV]: NEW }
  expect(arrive(stayed)).toEqual({ from: OLD, to: NEW, stayed: true })
  expect(stayed[STAYED_ENV]).toBeUndefined()

  const left = writeHandoff(scratch.path, { from: OLD, to: NEW, drafts: [] })
  const fresh = path.join(path.dirname(left), "1.json")
  writeFileSync(fresh, "{}")
  const hourAgo = new Date(Date.now() - 60 * 60_000)
  utimesSync(left, hourAgo, hourAgo)
  arrive({}, scratch.path)
  expect(existsSync(left)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
})
