import { expect, test } from "bun:test"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { copyPlugin } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"

const session = {
  id: "ses_earlier_messages",
  title: "Earlier messages",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const id = (turn: number, role: number) => `msg_${String(turn).padStart(6, "0")}_${role}`
const messages: SessionMessageInfo[] = Array.from({ length: 40 }, (_, turn) => [
  { type: "user" as const, id: id(turn, 0), text: `History prompt ${turn}`, time: { created: turn * 10 } },
  {
    type: "assistant" as const,
    id: id(turn, 1),
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    finish: "stop" as const,
    time: { created: turn * 10 + 1, completed: turn * 10 + 2 },
    content: [
      { type: "text" as const, text: `History answer ${turn}\n\nIts reason ${turn}.\n\nIts follow-up ${turn}.` },
    ],
  },
]).flat()

/** The session open at its newest message, every older page held by the server until `release`. */
async function open() {
  const release = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  // Where the reader was when the server saw the older page's request.
  const at: { scroll?: ScrollBoxRenderable; top?: number } = {}
  const plugin = await copyPlugin("transcript-chrome")
  const app = await createAppFixture({
    width: 100,
    height: 30,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { enabled: false }, plugins: [plugin.directory] },
    fetch: async (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) {
        const cursor = url.searchParams.get("cursor")
        const end = Number(cursor ?? messages.length)
        const start = Math.max(0, end - Number(url.searchParams.get("limit")))
        if (cursor) {
          at.top ??= at.scroll?.scrollTop
          requested.resolve()
          await release.promise
        }
        return json({ data: messages.slice(start, end).toReversed(), cursor: start ? { next: String(start) } : {} })
      }
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
    },
  })
  await app.ready
  await waitForHighlightedFrame(app, (frame) => frame.includes("History answer 39"))
  await app.waitForVisualIdle({ quietFrames: 3 })
  const find = (node: Renderable): ScrollBoxRenderable | undefined =>
    node instanceof ScrollBoxRenderable && node.getRenderable(id(39, 0))
      ? node
      : node.getChildren().map(find).find(Boolean)
  const scroll = find(app.renderer.root)
  if (!scroll) throw new Error("Missing transcript")
  at.scroll = scroll
  let asked = false
  void requested.promise.then(() => (asked = true))
  const up = async (until: () => boolean) => {
    for (let tick = 0; tick < 300 && !until(); tick++) {
      await app.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "up")
      await app.renderOnce()
      // A real wheel sends at most about a step per frame. Back-to-back steps outran the older page's request on
      // a loaded host (it reached the server only at the top), on OpenTUI 0.8 and 0.9 alike.
      await Bun.sleep(16)
    }
  }
  return {
    app,
    scroll,
    up,
    asked: () => asked,
    askedAt: () => at.top,
    release: () => release.resolve(),
    async [Symbol.asyncDispose]() {
      release.resolve()
      await app[Symbol.asyncDispose]()
    },
  }
}

// Scrolled to the top of a long session, the reader sees older messages loading, not the session's start: the
// start (here a plugin's `session.transcript.start` row, Prime's splash in the owner's TUI) shows only once the
// first message is in.
test("the transcript's top says earlier messages load until the session's start is reached", async () => {
  await using view = await open()
  const { app, scroll, up } = view
  // At the top of what is loaded, with the next page held by the server.
  await up(() => view.asked() && scroll.scrollTop === 0)
  expect(view.asked()).toBe(true)
  await app.waitForVisualIdle({ quietFrames: 3 })
  const loading = app.captureCharFrame()
  expect(loading).toContain("Loading earlier messages…")
  expect(loading).not.toContain("Transcript start claimed")

  // Every older page answers; the reader keeps scrolling to the first message.
  view.release()
  await up(() => app.captureCharFrame().includes("History prompt 0") && scroll.scrollTop === 0)
  await app.waitForFrame((frame) => frame.includes("Transcript start claimed"))
  await app.waitForVisualIdle({ quietFrames: 3 })
  const start = app.captureCharFrame()
  expect(start).toContain("Transcript start claimed")
  expect(start).toContain("History prompt 0")
  expect(start).not.toContain("Loading earlier messages")
}, 30_000)

// The older page is asked for as the reader starts up through the loaded rows, not once they reach the top: on a
// loaded host the server answers seconds late, and the reader would sit at the top waiting.
test("scrolling up asks for the older page while loaded rows are still above the reader", async () => {
  await using view = await open()
  const { scroll, up } = view
  expect(scroll.scrollTop).toBeGreaterThan(2 * scroll.viewport.height)
  await up(() => view.asked())
  expect(view.asked()).toBe(true)
  // Asked while a viewport of loaded rows was still above the reader, not at the top.
  expect(view.askedAt()).toBeGreaterThan(scroll.viewport.height)
}, 30_000)
