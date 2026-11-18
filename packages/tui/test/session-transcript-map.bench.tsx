// Measures how long the transcript map takes to open on a long session (TURNS turns of prompt, agent run and
// notice: three map lines each, from four outline entries), from the key to the frame that shows its newest line,
// then the cost of typing a filter and of opening it again from the cache. Run by path; not part of the suite:
//   bun test ./test/session-transcript-map.bench.tsx   (MAP_TURNS=20000 for a longer session)
import { expect, test } from "bun:test"
import type { SessionMessageInfo, SessionOutlineEntry } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"

const TURNS = Number(process.env.MAP_TURNS ?? 5_000)
const session = {
  id: "ses_transcript_map_bench",
  title: "Transcript map bench",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const start = new Date(2026, 10, 10, 9, 0).getTime()
const id = (turn: number, role: number) => `msg_${String(turn).padStart(6, "0")}_${role}`
const outline: SessionOutlineEntry[] = Array.from({ length: TURNS }, (_, turn) => {
  const time = start + turn * 120_000
  return [
    { id: id(turn, 0), type: "user" as const, time, summary: `Prompt number ${turn} about the scroll bench` },
    { id: id(turn, 1), type: "assistant" as const, time: time + 1000, tools: 3 },
    {
      id: id(turn, 2),
      type: "assistant" as const,
      time: time + 2000,
      summary: `Answer ${turn}.`,
      tools: 1,
      thoughts: 2,
    },
    {
      id: id(turn, 3),
      type: "synthetic" as const,
      time: time + 3000,
      summary: `monitor w${turn} matched`,
      source: "wake",
    },
  ]
}).flat()
// The transcript holds only the newest page, as a long session's does when it opens.
const messages: SessionMessageInfo[] = Array.from({ length: 20 }, (_, index) => {
  const turn = TURNS - 20 + index
  return {
    type: "user" as const,
    id: id(turn, 0),
    text: `Prompt number ${turn} about the scroll bench`,
    time: { created: start + turn * 120_000 },
  }
})

test(`the transcript map opens on a ${TURNS}-turn session`, async () => {
  const app = await createAppFixture({
    width: 120,
    height: 40,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { enabled: false } },
    fetch: async (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/outline`) {
        const after = url.searchParams.get("after")
        const index = after ? outline.findIndex((entry) => entry.id === after) + 1 : 0
        return json({ data: outline.slice(index) })
      }
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({ data: messages.toReversed(), cursor: { next: "older" } })
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
    },
  })
  try {
    await app.ready
    await waitForHighlightedFrame(app, (frame) => frame.includes(`Prompt number ${TURNS - 1}`))
    await app.waitForVisualIdle({ quietFrames: 3 })
    const newest = `monitor w${TURNS - 1} matched`
    const open = async () => {
      const began = performance.now()
      app.mockInput.pressKey("x", { ctrl: true })
      app.mockInput.pressKey("g")
      await app.waitForFrame((frame) => frame.includes("Transcript map") && frame.includes(newest))
      return performance.now() - began
    }
    const first = await open()
    const began = performance.now()
    app.mockInput.pressKey("/")
    await app.mockInput.typeText("w4321 ")
    await app.waitForFrame((frame) => frame.includes("1 of"))
    const filtered = performance.now() - began
    app.mockInput.pressEscape()
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("Transcript map"))
    const again = await open()
    console.log(
      JSON.stringify({
        turns: TURNS,
        lines: TURNS * 3,
        entries: outline.length,
        firstOpenMs: Math.round(first),
        filterMs: Math.round(filtered),
        cachedOpenMs: Math.round(again),
      }),
    )
    expect(first).toBeLessThan(5_000)
  } finally {
    await app[Symbol.asyncDispose]()
  }
}, 60_000)
