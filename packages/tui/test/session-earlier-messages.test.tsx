import { expect, test } from "bun:test"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { copyPlugin } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"

// Scrolled to the top of a long session, the reader sees older messages loading, not the session's start: the
// start (here a plugin's `session.transcript.start` row, Prime's splash in the owner's TUI) shows only once the
// first message is in.
test("the transcript's top says earlier messages load until the session's start is reached", async () => {
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
      content: [{ type: "text" as const, text: `History answer ${turn}` }],
    },
  ]).flat()
  const release = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  const plugin = await copyPlugin("transcript-chrome")
  await using app = await createAppFixture({
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
          requested.resolve()
          await release.promise
        }
        return json({ data: messages.slice(start, end).toReversed(), cursor: start ? { next: String(start) } : {} })
      }
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
    },
  })
  try {
    await app.ready
    await waitForHighlightedFrame(app, (frame) => frame.includes("History answer 39"))
    await app.waitForVisualIdle({ quietFrames: 3 })
    const find = (node: Renderable): ScrollBoxRenderable | undefined =>
      node instanceof ScrollBoxRenderable && node.getRenderable(id(39, 0))
        ? node
        : node.getChildren().map(find).find(Boolean)
    const scroll = find(app.renderer.root)
    if (!scroll) throw new Error("Missing transcript")
    const up = async (until: () => boolean) => {
      for (let tick = 0; tick < 300 && !until(); tick++) {
        await app.mockMouse.scroll(scroll.viewport.x + 2, scroll.viewport.y + 2, "up")
        await app.renderOnce()
      }
    }
    // At the top of what is loaded, with the next page held by the server.
    let waiting = false
    void requested.promise.then(() => (waiting = true))
    await up(() => waiting && scroll.scrollTop === 0)
    await requested.promise
    await app.waitForVisualIdle({ quietFrames: 3 })
    const loading = app.captureCharFrame()
    expect(loading).toContain("Loading earlier messages…")
    expect(loading).not.toContain("Transcript start claimed")

    // Every older page answers; the reader keeps scrolling to the first message.
    release.resolve()
    await up(() => app.captureCharFrame().includes("History prompt 0") && scroll.scrollTop === 0)
    await app.waitForFrame((frame) => frame.includes("Transcript start claimed"))
    await app.waitForVisualIdle({ quietFrames: 3 })
    const start = app.captureCharFrame()
    expect(start).toContain("Transcript start claimed")
    expect(start).toContain("History prompt 0")
    expect(start).not.toContain("Loading earlier messages")
  } finally {
    release.resolve()
  }
}, 30_000)
