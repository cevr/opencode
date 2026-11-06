// One Escape on a busy session with an empty composer: inside the grace after you sent the latest prompt it cancels
// (interrupt, revert, prompt back in the composer); after it, it interrupts; a queued prompt comes back whatever the
// grace. The clock is faked with setSystemTime, so "1 s after sending" is exact.
import { afterEach, expect, setSystemTime, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { lastSent, noteSent } from "../src/prompt/escape"
import type { Config } from "../src/config"

const SENT_AT = new Date("2026-11-05T10:00:00Z").getTime()

function info(id: string, title: string, parentID?: string) {
  return {
    id,
    title,
    parentID,
    projectID: "proj_test",
    agent: "build",
    model: { providerID: "demo", id: "model" },
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
}

const parent = info("ses_escape", "Escape")
const child = info("ses_escape_child", "Child", parent.id)
// The transcript: an earlier finished turn, then the prompt just sent and the answer streaming for it.
const transcript = [
  {
    type: "assistant",
    id: "msg_stream",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    time: { created: 4 },
    content: [{ type: "text", text: "Streaming the answer" }],
  },
  { type: "user", id: "msg_ask", text: "Rename the helper", time: { created: 3 } },
  {
    type: "assistant",
    id: "msg_reply",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    finish: "stop",
    time: { created: 2, completed: 2 },
    content: [{ type: "text", text: "Earlier answer" }],
  },
  { type: "user", id: "msg_first", text: "Look around", time: { created: 1 } },
]
const queued = {
  id: "msg_queued",
  sessionID: parent.id,
  type: "user",
  delivery: "queue",
  payload: { text: "Then add tests" },
  time: { created: 5 },
}

afterEach(() => setSystemTime())

/** Opens a running session against a fake server; `calls` logs every request that changes something. */
async function openSession(
  input: {
    config?: Config.Info
    inbox?: unknown[]
    revert?: () => Response
    route?: typeof parent
    running?: string[]
  } = {},
) {
  for (const id of [undefined, parent.id, child.id]) takeDraft(id)
  const calls: string[] = []
  const route = input.route ?? parent
  const app = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { enabled: false }, ...input.config },
    args: { sessionID: route.id },
    fetch: async (url, request) => {
      const [, id, rest] = /^\/api\/(?:experimental\/)?session\/([^/]+)(.*)$/.exec(url.pathname) ?? []
      const session = [parent, child].find((item) => item.id === id)
      if (request.method !== "GET" && session) {
        const body = await request.text()
        const target = session === child ? "child" : ""
        calls.push(`${request.method} ${target}${rest}${url.search}${body && body !== "{}" ? ` ${body}` : ""}`)
      }
      if (url.pathname === "/api/session/active")
        return json({ data: Object.fromEntries((input.running ?? [route.id]).map((id) => [id, { type: "running" }])) })
      if (url.pathname === "/api/session") return json({ data: [parent], cursor: {} })
      // An agent and a model, so a typed prompt can be sent.
      const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [{ id: "model", providerID: "demo", name: "Model", variants: [], cost: [], time: { released: 0 } }],
        })
      if (!session) return undefined
      if (rest === "/message") return json({ data: session === parent ? transcript : [], cursor: {} })
      if (rest === "" || rest === "/interrupt") return json({ data: session })
      if (rest === "/inbox" && request.method === "GET")
        return json({ data: session === parent ? (input.inbox ?? []) : [] })
      if (rest.startsWith("/inbox/")) return new Response(null, { status: 204 })
      if (rest === "/permission" || rest === "/form") return json({ data: [] })
      if (rest === "/wait") return new Response(null, { status: 204 })
      if (rest === "/revert/stage") return input.revert?.() ?? json({ data: session })
      if (rest === "/prompt") {
        const prompt = JSON.parse(calls.at(-1)!.slice(calls.at(-1)!.indexOf(" {") + 1))
        return json({
          data: {
            id: prompt.id,
            sessionID: session.id,
            type: "user",
            time: { created: 10 },
            payload: { text: prompt.text },
            delivery: "steer",
          },
        })
      }
      if (rest === "/agent" || rest === "/model") return new Response(null, { status: 204 })
      return undefined
    },
  })
  await app.waitForFrame((frame) => frame.includes(route === parent ? "Streaming the answer" : "Subagents"))
  return Object.assign(app, { calls })
}

type App = Awaited<ReturnType<typeof openSession>>

async function settled(app: App, done: (frame: string) => boolean = () => true) {
  await app.waitForFrame(done)
  await Bun.sleep(50)
  return app.waitForFrame(() => true)
}

// How many times the frame shows the prompt: once in the transcript, twice once it is also back in the composer.
const shown = (frame: string, text: string) => frame.split(text).length - 1

test("Escape 1 s after sending cancels: interrupt, revert, and the prompt is back in the composer", async () => {
  noteSent(parent.id, "msg_ask", SENT_AT)
  setSystemTime(SENT_AT + 1000)
  await using app = await openSession()
  // Real timers drive the countdown, so the hint reads the faked clock at render: 4 s left.
  expect(await settled(app, (frame) => frame.includes("esc cancel and edit"))).toContain("esc cancel and edit · 4s")
  // The hint re-reads the clock each whole second.
  setSystemTime(SENT_AT + 2500)
  await Bun.sleep(1100)
  expect(await app.waitForFrame((frame) => frame.includes("esc cancel and edit"))).toContain("esc cancel and edit · 3s")

  app.mockInput.pressEscape()
  const frame = await settled(app, (frame) => app.calls.some((call) => call.includes("/revert/stage")))
  expect(app.calls).toEqual(["POST /interrupt", "POST /wait", 'POST /revert/stage {"messageID":"msg_ask"}'])
  expect(shown(frame, "Rename the helper")).toBe(2)
}, 20000)

test("Escape after the grace interrupts at once and keeps the prompt", async () => {
  noteSent(parent.id, "msg_ask", SENT_AT)
  setSystemTime(SENT_AT + 7000)
  await using app = await openSession()
  expect(await settled(app, (frame) => frame.includes("esc interrupt"))).not.toContain("cancel and edit")

  app.mockInput.pressEscape()
  const frame = await settled(app, () => app.calls.length > 0)
  expect(app.calls).toEqual(["POST /interrupt?resume=true"])
  expect(shown(frame, "Rename the helper")).toBe(1)
}, 20000)

test("a prompt this TUI did not send only interrupts", async () => {
  noteSent(parent.id, "msg_other", SENT_AT)
  setSystemTime(SENT_AT + 1000)
  await using app = await openSession()
  app.mockInput.pressEscape()
  await settled(app, () => app.calls.length > 0)
  expect(app.calls).toEqual(["POST /interrupt?resume=true"])
}, 20000)

test("escape_cancel_grace 0 always interrupts", async () => {
  noteSent(parent.id, "msg_ask", SENT_AT)
  setSystemTime(SENT_AT + 100)
  await using app = await openSession({ config: { escape_cancel_grace: 0 } as Config.Info })
  expect(await settled(app, (frame) => frame.includes("esc interrupt"))).not.toContain("cancel and edit")
  app.mockInput.pressEscape()
  await settled(app, () => app.calls.length > 0)
  expect(app.calls).toEqual(["POST /interrupt?resume=true"])
}, 20000)

test("a queued prompt comes back into the composer whatever the grace", async () => {
  noteSent(parent.id, "msg_ask", SENT_AT)
  setSystemTime(SENT_AT + 60_000)
  await using app = await openSession({ inbox: [queued] })
  expect(await settled(app, (frame) => frame.includes("esc edit queued"))).toContain("esc edit queued")

  app.mockInput.pressEscape()
  const frame = await settled(app, () => app.calls.length > 0)
  expect(app.calls).toEqual(["DELETE /inbox/msg_queued"])
  expect(await settled(app, (frame) => !frame.includes("esc edit queued"))).toContain("Then add tests")
  expect(frame).toContain("Rename the helper")
}, 20000)

test("with text in the composer, Escape leaves the session alone", async () => {
  noteSent(parent.id, "msg_ask", SENT_AT)
  setSystemTime(SENT_AT + 1000)
  await using app = await openSession()
  await app.mockInput.typeText("draft")
  expect(await settled(app, (frame) => frame.includes("draft"))).not.toContain("esc cancel")
  app.mockInput.pressEscape()
  app.mockInput.pressEscape()
  await settled(app)
  expect(app.calls).toEqual([])
}, 20000)

test("with the command palette open, Escape closes it and nothing else", async () => {
  noteSent(parent.id, "msg_ask", SENT_AT)
  setSystemTime(SENT_AT + 1000)
  await using app = await openSession()
  app.mockInput.pressKey("p", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("Commands"))
  app.mockInput.pressEscape()
  expect(await settled(app, (frame) => !frame.includes("Commands"))).toContain("esc cancel and edit")
  expect(app.calls).toEqual([])
}, 20000)

test("when the revert fails, Escape still cancels and restores the prompt, and says so", async () => {
  noteSent(parent.id, "msg_ask", SENT_AT)
  setSystemTime(SENT_AT + 1000)
  await using app = await openSession({
    revert: () => json({ _tag: "SessionBusyError", message: "still busy" }, { status: 409 }),
  })
  app.mockInput.pressEscape()
  const frame = await settled(app, (frame) => frame.includes("couldn't revert"))
  expect(app.calls).toEqual(["POST /interrupt", "POST /wait", 'POST /revert/stage {"messageID":"msg_ask"}'])
  expect(shown(frame, "Rename the helper")).toBe(2)
}, 20000)

test("in a busy subagent view Escape interrupts that subagent only", async () => {
  await using app = await openSession({ route: child, running: [parent.id, child.id] })
  expect(await settled(app, (frame) => frame.includes("esc interrupt"))).toContain("esc interrupt")
  app.mockInput.pressEscape()
  const frame = await settled(app, () => app.calls.length > 0)
  expect(app.calls).toEqual(["POST child/interrupt?resume=true"])
  expect(frame).not.toContain("Streaming the answer")
}, 20000)

test("in an idle subagent view Escape still goes back to the parent", async () => {
  await using app = await openSession({ route: child, running: [parent.id] })
  app.mockInput.pressEscape()
  await settled(app, (frame) => frame.includes("Streaming the answer"))
  expect(app.calls).toEqual([])
}, 20000)

test("sending a prompt records the ID it is sent with", async () => {
  await using app = await openSession({ running: [] })
  await app.mockInput.typeText("Next step")
  app.mockInput.pressEnter()
  await settled(app, () => app.calls.some((call) => call.startsWith("POST /prompt")))
  const sent = app.calls.find((call) => call.startsWith("POST /prompt"))!
  const recorded = lastSent(parent.id)
  expect(recorded).toBeDefined()
  expect(JSON.parse(sent.slice("POST /prompt ".length)).id).toBe(recorded!.messageID)
}, 20000)
