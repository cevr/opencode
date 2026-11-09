import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

// A reconnect reloads the session on screen. The reload can fail for a moment
// (a restarted service still booting answers 503, a second restart drops the
// request): the session stays on screen and the reload is tried again. Only a
// session the server says is gone sends the TUI home.

const session = {
  id: "ses_reconnect_route",
  title: "Reconnect route",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const messages = [
  { type: "user", id: "msg_01_a", text: "Reconnect prompt marker", time: { created: 1 } },
  {
    type: "assistant",
    id: "msg_01_b",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    finish: "stop",
    time: { created: 2, completed: 3 },
    content: [{ type: "text", text: "Reconnect answer marker" }],
  },
].toReversed()

type Answer = "ok" | "unavailable" | "gone"

async function until(done: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

async function reconnectWhile(answer: () => Answer) {
  let gets = 0
  const setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { enabled: false } },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) {
        gets++
        const now = answer()
        if (now === "unavailable")
          return json({ code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } })
        if (now === "gone")
          return json(
            { _tag: "SessionNotFoundError", sessionID: session.id, message: `Session not found: ${session.id}` },
            { status: 404 },
          )
        return json({ data: session })
      }
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
      return undefined
    },
  })
  await setup.waitForFrame((frame) => frame.includes("Reconnect answer marker"))
  return { setup, gets: () => gets }
}

test("a reload that fails for a moment after a reconnect keeps the session and tries again", async () => {
  let state: Answer = "ok"
  const { setup, gets } = await reconnectWhile(() => state)
  await using _ = setup
  state = "unavailable"
  const before = gets()
  setup.events.disconnect()
  // The reconnect's reload is refused, at least once.
  await until(() => gets() > before)
  await Bun.sleep(300)
  expect(setup.captureCharFrame()).toContain("Reconnect answer marker")
  state = "ok"
  const refused = gets()
  // Tried again with no further reconnect, and the session is still the one on screen.
  await until(() => gets() > refused, 10_000)
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(setup.captureCharFrame()).toContain("Reconnect answer marker")
}, 20_000)

test("a session the server says is gone after a reconnect sends the TUI home", async () => {
  let state: Answer = "ok"
  const { setup } = await reconnectWhile(() => state)
  await using _ = setup
  state = "gone"
  setup.events.disconnect()
  await until(() => setup.captureCharFrame().includes("Session not found"), 10_000)
  await until(() => !setup.captureCharFrame().includes("Reconnect answer marker"), 10_000)
}, 20_000)
