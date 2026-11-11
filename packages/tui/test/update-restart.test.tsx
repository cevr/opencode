import { expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import { arrive, HANDOFF_ENV, movesForward, writeHandoff, type RestartPlan } from "../src/context/update-restart"
import { takeDraft } from "../src/component/prompt/draft-stash"

// The moves wait out an idle time and a notice, and the TUI boots twice.
setDefaultTimeout(40_000)

const OLD = "2.2.5-prime.5cd5a2b9"
const NEW = "2.2.7-prime.13a38089"

const session = {
  id: "ses_reexec",
  projectID: "proj_test",
  location: { directory },
  title: "Reexec session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

/** A fake service whose build an install can move, and the installed build's command, which reports its version. */
async function service(dir: string) {
  const command = path.join(dir, "opencode-new")
  await Bun.write(command, `#!/bin/sh\necho ${NEW}\n`)
  chmodSync(command, 0o755)
  const state = { served: OLD }
  const fetch = (url: URL) => {
    if (url.pathname === "/api/info")
      return json({ version: state.served, pid: 1, urls: [], command: [command], paths: { tmp: "/tmp" } })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`)
      return json({
        data: [{ id: "msg_reexec_user", type: "user", text: "Earlier question", time: { created: 1 } }],
        cursor: {},
      })
    if ([`/api/session/${session.id}/inbox`, `/api/session/${session.id}/permission`].includes(url.pathname))
      return json({ data: [] })
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    return undefined
  }
  return { command, state, fetch }
}

const settled = <T,>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, Bun.sleep(ms).then(() => "pending" as const)])

test("an old TUI on a session moves onto the service's newer build, on the same session with its draft", async () => {
  await using scratch = await tmpdir()
  const state = path.join(scratch.path, "state")
  const fake = await service(scratch.path)
  await using old = await createAppFixture({
    state,
    version: OLD,
    managed: true,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" }, update: { idle: 0 } },
    fetch: fake.fetch,
  })
  await old.ready
  await old.waitForFrame((frame) => frame.includes("Earlier question"))
  await old.mockInput.typeText("Carry this draft")
  await old.waitForFrame((frame) => frame.includes("Carry this draft"))

  // The install restarts the service onto its new build; the TUI's event stream reconnects to it.
  fake.state.served = NEW
  old.events.disconnect()
  await old.waitForFrame((frame) => frame.includes(`OpenCode ${NEW} is installed`))
  const result = (await settled(old.task, 15_000)) as { restart?: RestartPlan } | "pending"
  expect(result).not.toBe("pending")
  const plan = (result as { restart?: RestartPlan }).restart
  expect(plan?.command).toEqual([fake.command])
  expect(plan?.args).toEqual(["-s", session.id])
  const file = plan!.env[HANDOFF_ENV]!
  expect(path.dirname(file)).toBe(path.join(state, "tui-handoff"))

  // The next process starts on the session with the handoff named, as `-s` and the environment give it.
  process.env[HANDOFF_ENV] = file
  await using next = await createAppFixture({
    state,
    version: NEW,
    managed: true,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: (url) => {
      fake.state.served = NEW
      return fake.fetch(url)
    },
  })
  await next.ready
  await next.waitForFrame((frame) => frame.includes("Earlier question") && frame.includes("Carry this draft"))
  expect(process.env[HANDOFF_ENV]).toBeUndefined()
  expect(existsSync(file)).toBe(false)
  // Same build as the service: it stays.
  expect(await settled(next.task, 1_500)).toBe("pending")
})

test("a key pressed holds the move, and it goes once the keys stop", async () => {
  await using scratch = await tmpdir()
  const fake = await service(scratch.path)
  await using old = await createAppFixture({
    state: path.join(scratch.path, "state"),
    version: OLD,
    managed: true,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" }, update: { idle: 1 } },
    fetch: fake.fetch,
  })
  await old.ready
  await old.waitForFrame((frame) => frame.includes("Earlier question"))
  fake.state.served = NEW
  old.events.disconnect()
  // Typing, a key every 300 ms for 5 s: never a quiet second, so neither the notice nor the move comes.
  const typing = (async () => {
    for (let index = 0; index < 16; index++) {
      await old.mockInput.typeText("x")
      await Bun.sleep(300)
    }
  })()
  expect(await settled(old.task, 4_500)).toBe("pending")
  expect(old.captureCharFrame()).not.toContain("is installed")
  await typing
  expect(await settled(old.task, 8_000)).not.toBe("pending")
})

test("the off switch keeps the TUI on its build", async () => {
  await using scratch = await tmpdir()
  const fake = await service(scratch.path)
  await using old = await createAppFixture({
    state: path.join(scratch.path, "state"),
    version: OLD,
    managed: true,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" }, update: { restart: false, idle: 0 } },
    fetch: fake.fetch,
  })
  await old.ready
  await old.waitForFrame((frame) => frame.includes("Earlier question"))
  fake.state.served = NEW
  old.events.disconnect()
  expect(await settled(old.task, 5_000)).toBe("pending")
  expect(old.captureCharFrame()).not.toContain("is installed")
})

test("a TUI without a managed service never moves", async () => {
  await using scratch = await tmpdir()
  const fake = await service(scratch.path)
  fake.state.served = NEW
  await using old = await createAppFixture({
    state: path.join(scratch.path, "state"),
    version: OLD,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" }, update: { idle: 0 } },
    fetch: fake.fetch,
  })
  await old.ready
  await old.waitForFrame((frame) => frame.includes("Earlier question"))
  expect(await settled(old.task, 5_000)).toBe("pending")
})

test("a build moves forward to a different build of its release or a later release, never back", () => {
  expect(movesForward(OLD, NEW)).toBe(true)
  expect(movesForward("2.2.7-prime.aaaaaaaa", "2.2.7-prime.bbbbbbbb")).toBe(true)
  expect(movesForward(NEW, OLD)).toBe(false)
  expect(movesForward(NEW, NEW)).toBe(false)
  expect(movesForward(NEW, "unknown")).toBe(false)
  expect(movesForward("local", NEW)).toBe(false)
  expect(movesForward(NEW, "local")).toBe(false)
  expect(movesForward("1.9.9", "2.0.0")).toBe(true)
})

test("the handoff carries every tab's draft, and is read once", async () => {
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
  expect(arrive(env)).toEqual({ from: OLD, to: NEW })
  expect(env[HANDOFF_ENV]).toBeUndefined()
  expect(existsSync(file)).toBe(false)
  expect(takeDraft("ses_a")).toEqual({ prompt: prompt("on a"), cursor: 2 })
  expect(takeDraft(undefined)).toEqual({ prompt: prompt("on home"), cursor: Infinity })
  expect(arrive({ [HANDOFF_ENV]: file })).toBeUndefined()
})
