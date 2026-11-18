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
// The server's outline: a summary per message, and each answer's work (counts only; its body stays on the server).
const outline: SessionOutlineEntry[] = messages.map((message) =>
  message.type === "assistant"
    ? {
        id: message.id,
        type: message.type,
        time: message.time.created,
        completed: message.time.completed,
        summary: `Answer about ${topic(Number(message.id.slice(4, 10)))}.`,
        thoughts: 2,
        tools: 3,
      }
    : {
        id: message.id,
        type: message.type,
        time: message.time.created,
        summary: "text" in message ? message.text : "",
      },
)

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
      await app.waitForFrame((frame) => frame.includes("/ filters by text"))
    },
    async [Symbol.asyncDispose]() {
      release.resolve()
      await app[Symbol.asyncDispose]()
    },
  }
}

/** The transcript's rows as the frame shows them, without the composer and footer below. */
const transcript = (frame: string) => frame.split("\n").slice(0, 20).join("\n")
/** The first topic a frame shows. */
const firstTopic = (frame: string) => /topic-\d{3}/.exec(frame)?.[0]

test("the transcript map takes the transcript's place, filters, and goes to an old turn", async () => {
  await using view = await open()
  const { app } = view
  await view.openMap()
  await app.waitForFrame((frame) => frame.includes(`Look into ${topic(TURNS - 1)}`))
  const map = app.captureCharFrame()
  // In the transcript's place: the composer and its footer stay; the transcript's rows are gone.
  expect(map).toContain("shift+tab agents")
  expect(map).not.toContain("More detail follows")
  // Newest at the bottom, one collapsed line each: its time as the transcript writes it, who, a summary, and an
  // answer's work counted, with the day it fell on.
  const zone = /\d{1,2}:\d{2} [AP]M [A-Z][A-Za-z+\-:\d]*/
  const line = (text: string) => map.split("\n").find((row) => row.includes(text)) ?? ""
  expect(line(`Look into ${topic(TURNS - 1)}`)).toMatch(
    new RegExp(`10:55 PM [A-Z][A-Za-z+\\-:\\d]*  you         Look into ${topic(TURNS - 1)}`),
  )
  expect(line(`Answer about ${topic(TURNS - 1)}`)).toContain(
    `agent       Answer about ${topic(TURNS - 1)}. · 2 thoughts, 3 tools`,
  )
  expect(line(`Answer about ${topic(TURNS - 1)}`)).toMatch(zone)
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

  // The turn is pages back: the transcript, back in its place, says so while they load.
  await app.waitForFrame((frame) => frame.includes("Loading earlier messages…") && !frame.includes("Transcript map"))
  expect(view.older()).toBeGreaterThan(0)
  view.release()
  await app.waitForFrame(
    (frame) => frame.includes(`Look into ${topic(7)}`) && frame.includes(`Answer about ${topic(7)}`),
  )
  await app.waitForVisualIdle({ quietFrames: 3 })
  // The turn's start is the transcript's first topic.
  expect(firstTopic(transcript(app.captureCharFrame()))).toBe(topic(7))
  expect(app.captureCharFrame()).not.toContain(topic(TURNS - 1))
}, 30_000)

test("leaving the map shows the transcript where it was; enter on the turn it opened at goes to its start", async () => {
  await using view = await open()
  const { app } = view
  const composer = () => app.renderer.currentFocusedEditor?.plainText
  expect(composer()).toBe("")
  // Somewhere up the loaded rows, not at the bottom.
  for (let step = 0; step < 6; step++) {
    await app.mockMouse.scroll(10, 5, "up")
    await app.renderOnce()
  }
  await app.waitForVisualIdle({ quietFrames: 3 })
  const before = transcript(app.captureCharFrame())
  const top = firstTopic(before)
  expect(top).toBeDefined()
  expect(before).not.toContain(`Answer about ${topic(TURNS - 1)}`)

  // Esc: back where it was, though the map moved.
  await view.openMap()
  app.mockInput.pressKey("\x1b[5~") // PgUp
  app.mockInput.pressKey("g")
  await app.waitForFrame((frame) => frame.includes(topic(0)))
  // The session's own chords are off in the map (undo, copy, a chord's miss): they leave it open and type nothing.
  for (const key of ["u", "y", "k"]) {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey(key)
    await app.renderOnce()
  }
  expect(app.captureCharFrame()).toContain("Transcript map")
  // An app-wide one still opens its dialog over the map; closing the dialog leaves the map with the keys.
  app.mockInput.pressKey("x", { ctrl: true })
  app.mockInput.pressKey("l")
  await app.waitForFrame((frame) => frame.includes("Sessions"))
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !frame.includes("Sessions") && frame.includes("Transcript map"))
  app.mockInput.pressKey("j")
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("Transcript map")
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !frame.includes("Transcript map"))
  await app.waitForVisualIdle({ quietFrames: 3 })
  expect(transcript(app.captureCharFrame())).toBe(before)
  expect(view.older()).toBe(0)
  // The composer has its focus back, and no key the map took reached it.
  expect(composer()).toBe("")

  // The toggle leaves it the same way, its second key spent on the toggle, not typed into the draft.
  await view.openMap()
  app.mockInput.pressKey("x", { ctrl: true })
  app.mockInput.pressKey("g")
  await app.waitForFrame((frame) => !frame.includes("Transcript map"))
  await app.waitForVisualIdle({ quietFrames: 3 })
  expect(transcript(app.captureCharFrame())).toBe(before)
  expect(composer()).toBe("")

  // It opens on the turn at the transcript's top; enter goes to that turn's start.
  await view.openMap()
  expect(view.outlines()).toBe(3)
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => !frame.includes("Transcript map"))
  await app.waitForVisualIdle({ quietFrames: 3 })
  const after = transcript(app.captureCharFrame())
  // The turn at the top was the one whose rows filled it: the first topic shown, or the answer above it whose
  // start had scrolled out. Either way the transcript now starts at that turn's first line.
  const opened = firstTopic(after)!
  expect([top, topic(Number(top!.slice("topic-".length)) - 1)]).toContain(opened)
  const first = after.split("\n").find((line) => line.trim() !== "")
  expect(first).toContain(opened)
  expect(composer()).toBe("")
}, 30_000)
