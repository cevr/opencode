import { expect, test } from "bun:test"
import type { SessionMessageInfo, SessionOutlineEntry } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"

const session = {
  id: "ses_transcript_map",
  title: "Map fixture",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const TURNS = 300
// Overnight work: a turn every five minutes from 22:00, so the session spans three days.
const start = new Date(2026, 10, 16, 22, 0).getTime()
const topic = (turn: number) => `topic-${String(turn).padStart(3, "0")}`
const id = (turn: number, role: number) => `msg_${String(turn).padStart(6, "0")}_${role}`
const messages: SessionMessageInfo[] = Array.from({ length: TURNS }, (_, turn) => [
  {
    type: "user" as const,
    id: id(turn, 0),
    text: `Look into ${topic(turn)}`,
    time: { created: start + turn * 300_000 },
  },
  {
    type: "assistant" as const,
    id: id(turn, 1),
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    finish: "stop" as const,
    time: { created: start + turn * 300_000 + 1000, completed: start + turn * 300_000 + 2000 },
    content: [{ type: "text" as const, text: `Answer about ${topic(turn)}. More detail follows.` }],
  },
]).flat()
const outline: SessionOutlineEntry[] = messages.map((message) => ({
  id: message.id,
  type: message.type,
  time: message.time.created,
  text:
    message.type === "user"
      ? message.text
      : message.type === "assistant" && message.content[0]?.type === "text"
        ? message.content[0].text
        : undefined,
}))

async function open() {
  // Older pages wait on the test, so it sees the transcript while they load.
  const release = Promise.withResolvers<void>()
  let older = 0
  let outlines = 0
  const app = await createAppFixture({
    width: 100,
    height: 30,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { enabled: false } },
    fetch: async (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/outline`) {
        outlines++
        const after = url.searchParams.get("after")
        const index = after ? outline.findIndex((entry) => entry.id === after) + 1 : 0
        return json({ data: outline.slice(index) })
      }
      if (url.pathname === `/api/session/${session.id}/message`) {
        const cursor = url.searchParams.get("cursor")
        const end = Number(cursor ?? messages.length)
        const begin = Math.max(0, end - Number(url.searchParams.get("limit")))
        if (cursor) {
          older++
          await release.promise
        }
        return json({ data: messages.slice(begin, end).toReversed(), cursor: begin ? { next: String(begin) } : {} })
      }
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
    },
  })
  await app.ready
  await waitForHighlightedFrame(app, (frame) => frame.includes(`Answer about ${topic(TURNS - 1)}`))
  await app.waitForVisualIdle({ quietFrames: 3 })
  return {
    app,
    older: () => older,
    outlines: () => outlines,
    release: () => release.resolve(),
    async openMap() {
      app.mockInput.pressKey("x", { ctrl: true })
      app.mockInput.pressKey("g")
      await app.waitForFrame((frame) => frame.includes("/ to filter by text") && frame.includes(topic(TURNS - 1)))
    },
    async [Symbol.asyncDispose]() {
      release.resolve()
      await app[Symbol.asyncDispose]()
    },
  }
}

test("the transcript map lists every turn, filters, and jumps to an old one", async () => {
  await using view = await open()
  const { app } = view
  await view.openMap()
  const map = app.captureCharFrame()
  // Newest at the bottom, one line each, with the day it fell on.
  expect(map).toContain(`you         Look into ${topic(TURNS - 1)}`)
  expect(map).toContain(`agent       Answer about ${topic(TURNS - 1)}.`)
  expect(map).toContain("— Tue Nov 17 —")
  expect(map).toContain(`${TURNS * 2} turns`)

  // `/` starts a filter; enter keeps it.
  app.mockInput.pressKey("/")
  await app.mockInput.typeText(topic(7))
  await app.waitForFrame((frame) => frame.includes(`2 of ${TURNS * 2} turns`))
  expect(app.captureCharFrame()).toContain("— Mon Nov 16 —")
  app.mockInput.pressEnter()
  // Letters move again: k selects the prompt above the answer.
  app.mockInput.pressKey("k")
  await app.renderOnce()
  app.mockInput.pressEnter()

  // The turn is pages back: the transcript says so while they load.
  await app.waitForFrame((frame) => frame.includes("Loading earlier messages…") && !frame.includes("Transcript map"))
  expect(view.older()).toBeGreaterThan(0)
  view.release()
  await app.waitForFrame(
    (frame) => frame.includes(`Look into ${topic(7)}`) && frame.includes(`Answer about ${topic(7)}`),
  )
  await app.waitForVisualIdle({ quietFrames: 3 })
  expect(app.captureCharFrame()).not.toContain(topic(TURNS - 1))
}, 30_000)

test("escape closes the map without moving, and a second open reads only what is new", async () => {
  await using view = await open()
  const { app } = view
  await view.openMap()
  // The map's keys move the map, not the transcript behind it.
  app.mockInput.pressKey("\x1b[5~") // PgUp
  app.mockInput.pressKey("\x1b[5~")
  await app.waitForFrame((frame) => frame.includes("Transcript map") && !frame.includes(`Look into ${topic(TURNS - 1)}`))
  app.mockInput.pressKey("g")
  await app.waitForFrame((frame) => frame.includes(topic(0)))
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !frame.includes("Transcript map"))
  await app.waitForVisualIdle({ quietFrames: 3 })
  expect(app.captureCharFrame()).toContain(`Answer about ${topic(TURNS - 1)}`)
  expect(view.older()).toBe(0)
  await view.openMap()
  expect(view.outlines()).toBe(2)
}, 30_000)
