import { rgbToHex } from "@opentui/core"
import { expect, test } from "bun:test"
import type { SessionMessageInfo, SessionOutlineEntry } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { copyPlugin } from "./fixture/fixture"
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
/**
 * The session: a prompt and its answer each turn. With `notices`, every tenth turn and the session's end are followed
 * by a notice queued at the session's start, which keeps the id it was made with (the oldest) though it arrives late.
 */
function sessionData(notices = false) {
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
    ...(notices && (turn % 10 === 9 || turn === TURNS - 1)
      ? [
          {
            type: "synthetic" as const,
            id: `msg_000000_${turn}`,
            text: "Notice",
            description: `Notice after ${topic(turn)}`,
            metadata: {},
            time: { created: start + turn * 300_000 + 3000 },
          },
        ]
      : []),
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
          summary: message.type === "synthetic" ? message.description : "text" in message ? message.text : "",
        },
  )
  return { messages, outline }
}

async function open(plugin?: string, { messages, outline } = sessionData()) {
  // Older pages wait on the test, so it sees the transcript while they load.
  const release = Promise.withResolvers<void>()
  let older = 0
  let outlines = 0
  const fixture = plugin ? await copyPlugin(plugin) : undefined
  const app = await createAppFixture({
    width: 100,
    height: 30,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { enabled: false }, plugins: fixture ? [fixture.directory] : undefined },
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
    async openMap(shown: (frame: string) => boolean = isMap) {
      app.mockInput.pressKey("x", { ctrl: true })
      app.mockInput.pressKey("g")
      await app.waitForFrame(shown)
      await app.waitForVisualIdle({ quietFrames: 3 })
    },
    async [Symbol.asyncDispose]() {
      release.resolve()
      await app[Symbol.asyncDispose]()
      await fixture?.[Symbol.asyncDispose]()
    },
  }
}

/** The transcript's rows as the frame shows them, without the composer and footer below. */
const transcript = (frame: string) => frame.split("\n").slice(0, 20).join("\n")
/** The first topic a frame shows. */
const firstTopic = (frame: string) => /topic-\d{3}/.exec(frame)?.[0]
/** The map is shown: an answer's work collapsed beside it (the transcript draws these answers as text alone). */
const isMap = (frame: string) => frame.includes("· + 2 thoughts, 3 tools")
const previous = (name: string) => topic(Number(name.slice("topic-".length)) - 1)

type Spans = ReturnType<Awaited<ReturnType<typeof createAppFixture>>["captureSpans"]>["lines"]
/** The span on line `y` holding `text`. */
const spanOf = (lines: Spans, y: number, text: string) => {
  const found = lines[y]?.spans.find((span) => span.text.includes(text))
  if (!found) throw new Error(`no span with ${JSON.stringify(text)} on line ${y}`)
  return found
}
const hex = (color: Parameters<typeof rgbToHex>[0]) => rgbToHex(color)
/** The background of the cell at column `x` of line `y`. */
const cellBg = (lines: Spans, y: number, x: number) => {
  let column = 0
  for (const span of lines[y]!.spans) {
    column += span.width
    if (column > x) return hex(span.bg)
  }
  return undefined
}

test("the map is the transcript with every turn collapsed, in its place and its look; it filters and goes to an old turn", async () => {
  await using view = await open()
  const { app } = view
  const expanded = app.captureCharFrame().split("\n")
  const expandedSpans = app.captureSpans().lines
  await view.openMap()
  const frame = app.captureCharFrame()
  const lines = frame.split("\n")
  const spans = app.captureSpans().lines
  // In the transcript's place: the composer and its footer stay; the transcript's rows are folded away.
  expect(frame).toContain("shift+tab agents")
  expect(frame).not.toContain("More detail follows")
  // No chrome of its own: no title, count or key hints.
  expect(frame).not.toMatch(/Transcript map|\d+ turns|esc back|filters by/)

  const lineOf = (rows: string[], text: string) => rows.findIndex((row) => row.includes(text))
  // A prompt is drawn as the transcript draws one, on one line: the same bar, column, colours and band.
  const prompt = `Look into ${topic(TURNS - 1)}`
  const p = lineOf(lines, prompt)
  const q = lineOf(expanded, prompt)
  expect(p).toBeGreaterThan(-1)
  expect(lines[p]!.indexOf("┃")).toBe(expanded[q]!.indexOf("┃"))
  expect(lines[p]!.indexOf(prompt)).toBe(expanded[q]!.indexOf(prompt))
  expect(hex(spanOf(spans, p, "┃").fg)).toBe(hex(spanOf(expandedSpans, q, "┃").fg))
  expect(hex(spanOf(spans, p, "Look into").fg)).toBe(hex(spanOf(expandedSpans, q, "Look into").fg))
  expect(hex(spanOf(spans, p, "Look into").bg)).toBe(hex(spanOf(expandedSpans, q, "Look into").bg))

  // A run is its first sentence where and as the transcript sets prose, then its work in the transcript's muted
  // `+ N thoughts, M tools` words, and the time it ended at the right edge.
  const answer = `Answer about ${topic(TURNS - 1)}.`
  const a = lineOf(lines, answer)
  const b = lineOf(expanded, answer)
  expect(lines[a]!.indexOf(answer)).toBe(expanded[b]!.indexOf(answer))
  expect(lines[a]).toMatch(new RegExp(`${answer} · \\+ 2 thoughts, 3 tools +10:55 PM [A-Z][A-Za-z+\\-:\\d]* *$`))
  expect(hex(spanOf(spans, a, "Answer about").fg)).toBe(hex(spanOf(expandedSpans, b, "Answer about").fg))
  const muted = hex(spanOf(spans, a, "+ 2 thoughts").fg)
  expect(muted).not.toBe(hex(spanOf(spans, a, "Answer about").fg))
  expect(hex(spanOf(spans, a, "10:55 PM").fg)).toBe(muted)
  // Every time ends on one column, whatever the sentence before it.
  const earlier = lineOf(lines, `Answer about ${topic(TURNS - 2)}.`)
  expect(lines[earlier]!.trimEnd().length).toBe(lines[a]!.trimEnd().length)
  // The rhythm is the transcript's, tighter: a run right under its prompt, a blank line above each prompt.
  expect(a).toBe(p + 1)
  expect(lines[p - 1]!.trim()).toBe("")

  // `/` starts a filter, on a line of its own while it is typed or kept; enter keeps it.
  app.mockInput.pressKey("/")
  await app.mockInput.typeText(topic(7))
  await app.waitForFrame((frame) => frame.includes(`/${topic(7)}`) && frame.includes(`2 of ${TURNS * 2} turns`))
  app.mockInput.pressEnter()
  // Letters move again: k selects the prompt above the answer.
  app.mockInput.pressKey("k")
  await app.renderOnce()
  const filtered = app.captureCharFrame().split("\n")
  const row = lineOf(filtered, `Look into ${topic(7)}`)
  app.mockInput.pressEnter()

  // The turn is pages back: the transcript, back in its place, says so while they load.
  await app.waitForFrame((frame) => frame.includes("Loading earlier messages…") && !isMap(frame))
  expect(view.older()).toBeGreaterThan(0)
  view.release()
  await app.waitForFrame(
    (frame) => frame.includes(`Look into ${topic(7)}`) && frame.includes(`Answer about ${topic(7)}`),
  )
  await app.waitForVisualIdle({ quietFrames: 3 })
  // The turn unfolds where its collapsed row was: its prompt's band starts on that line, its text below.
  const after = app.captureCharFrame().split("\n")
  expect(after[row]).toContain("┃")
  expect(after[row + 1]).toContain(`Look into ${topic(7)}`)
  expect(firstTopic(transcript(after.join("\n")))).toBe(topic(7))
  expect(after.join("\n")).not.toContain(topic(TURNS - 1))
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

  // The turn at the transcript's top keeps its line as the transcript folds: the line its rows start on (the top
  // line when its start has scrolled out above) holds its collapsed row, and it is the one selected. It is the first
  // topic shown, or the answer above it whose start had scrolled out.
  const start = before.split("\n").findIndex((line) => line.trim() !== "")
  await view.openMap()
  const folded = app.captureCharFrame().split("\n")
  const opened = firstTopic(folded[start]!)!
  expect([top, previous(top!)]).toContain(opened)
  expect(folded.slice(0, start).every((line) => line.trim() === "")).toBe(true)
  const spans = app.captureSpans().lines
  // Selection is the row's own subtle background, set against a row of the same kind.
  const kind = folded[start]!.includes("Look into") ? "Look into" : "Answer about"
  const plain = folded.findIndex((line, index) => index > start && line.includes(kind))
  expect(cellBg(spans, start, folded[start]!.indexOf(opened))).not.toBe(
    cellBg(spans, plain, folded[plain]!.indexOf("topic-")),
  )

  // Esc: back where it was, though the map moved.
  app.mockInput.pressKey("\x1b[5~") // PgUp
  app.mockInput.pressKey("g")
  await app.waitForFrame((frame) => frame.includes(topic(0)))
  // The first turn is the session's start, under its day's dim, centred label.
  const first = app.captureCharFrame().split("\n")
  const day = first.findIndex((line) => line.includes("Mon Nov 16"))
  expect(day).toBeGreaterThan(-1)
  expect(first[day]!.trim()).toBe("Mon Nov 16")
  const left = first[day]!.indexOf("Mon")
  const right = first[day]!.trimEnd().length
  expect(Math.abs(left - (100 - right))).toBeLessThanOrEqual(6)
  expect(first[day + 1]).toContain(`Look into ${topic(0)}`)
  // The session's own chords are off in the map (undo, copy, a chord's miss): they leave it open and type nothing.
  for (const key of ["u", "y", "k"]) {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey(key)
    await app.renderOnce()
  }
  expect(isMap(app.captureCharFrame())).toBe(true)
  // An app-wide one still opens its dialog over the map; closing the dialog leaves the map with the keys.
  app.mockInput.pressKey("x", { ctrl: true })
  app.mockInput.pressKey("l")
  await app.waitForFrame((frame) => frame.includes("Sessions"))
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !frame.includes("Sessions") && isMap(frame))
  // The dialog hands focus back a tick after it closes: the composer behind the map must not take it.
  await Bun.sleep(20)
  await app.renderOnce()
  expect(composer()).toBeUndefined()
  app.mockInput.pressKey("x", { ctrl: true })
  app.mockInput.pressKey("u")
  app.mockInput.pressKey("x")
  app.mockInput.pressKey("j")
  await app.renderOnce()
  expect(isMap(app.captureCharFrame())).toBe(true)
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !isMap(frame))
  await app.waitForVisualIdle({ quietFrames: 3 })
  expect(transcript(app.captureCharFrame())).toBe(before)
  expect(view.older()).toBe(0)
  // The composer has its focus back, and no key the map took reached it.
  expect(composer()).toBe("")

  // The toggle leaves it the same way, its second key spent on the toggle, not typed into the draft.
  await view.openMap()
  app.mockInput.pressKey("x", { ctrl: true })
  app.mockInput.pressKey("g")
  await app.waitForFrame((frame) => !isMap(frame))
  await app.waitForVisualIdle({ quietFrames: 3 })
  expect(transcript(app.captureCharFrame())).toBe(before)
  expect(composer()).toBe("")

  // Enter unfolds the transcript at the selected turn, its start landing on the line its collapsed row was on: one
  // turn below the one the map opened at.
  await view.openMap()
  expect(view.outlines()).toBe(3)
  app.mockInput.pressKey("j")
  await app.renderOnce()
  const map = app.captureCharFrame().split("\n")
  // From an answer, the next turn is the prompt after the blank line; from a prompt, its answer right under it.
  const prompt = map[start]!.includes("Answer about")
  const line = start + (prompt ? 2 : 1)
  const target = firstTopic(map[line]!)!
  expect(map[line]).toContain(prompt ? `Look into ${target}` : `Answer about ${target}`)
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => !isMap(frame))
  await app.waitForVisualIdle({ quietFrames: 3 })
  const after = app.captureCharFrame().split("\n")
  if (prompt) {
    expect(after[line]).toContain("┃")
    expect(after[line + 1]).toContain(`Look into ${target}`)
  } else expect(after[line]).toContain(`Answer about ${target}`)
  expect(composer()).toBe("")
}, 30_000)

test("pages up a long session whose notices arrive with old ids, the map opens on the turns that were on screen", async () => {
  await using view = await open(undefined, sessionData(true))
  const { app } = view
  view.release()
  // A dozen pages up: older rows mount and earlier pages load on the way.
  for (let page = 0; page < 12; page++) {
    app.mockInput.pressKey("\x1b[5~") // PgUp
    await app.renderOnce()
    await app.waitForVisualIdle({ quietFrames: 3 })
  }
  const before = transcript(app.captureCharFrame())
  const lines = before.split("\n")
  const top = firstTopic(before)!
  expect(Number(top.slice("topic-".length))).toBeLessThan(TURNS - 15)
  const start = lines.findIndex((line) => line.trim() !== "")
  // The prompts on screen, by topic.
  const prompts = lines.flatMap((line) => /Look into (topic-\d{3})/.exec(line)?.[1] ?? [])
  expect(prompts.length).toBeGreaterThan(1)

  await view.openMap()
  const folded = app.captureCharFrame().split("\n")
  // The turn at the transcript's top keeps its line and is the one selected; the lines above it stay blank.
  const opened = firstTopic(folded[start]!)!
  expect([top, previous(top)]).toContain(opened)
  expect(folded.slice(0, start).every((line) => line.trim() === "")).toBe(true)
  const spans = app.captureSpans().lines
  const kind = /Look into|Answer about|Notice after/.exec(folded[start]!)![0]
  const plain = folded.findIndex((line, index) => index > start && line.includes(kind))
  expect(cellBg(spans, start, folded[start]!.indexOf(opened))).not.toBe(
    cellBg(spans, plain, folded[plain]!.indexOf("topic-")),
  )
  // The turns that were on screen are on screen still, folded, in their order.
  const shown = folded.slice(0, 20).join("\n")
  for (const prompt of prompts) expect(shown).toContain(`Look into ${prompt}`)

  // Esc gives the transcript back exactly where it was.
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !isMap(frame))
  await app.waitForVisualIdle({ quietFrames: 3 })
  expect(transcript(app.captureCharFrame())).toBe(before)

  // Enter on a prompt below the opening turn unfolds it with its start on the line its collapsed row was on.
  await view.openMap()
  let line = start
  let map = app.captureCharFrame().split("\n")
  for (let step = 0; step < 4 && !(line > start && map[line]!.includes("Look into")); step++) {
    app.mockInput.pressKey("j")
    await app.renderOnce()
    map = app.captureCharFrame().split("\n")
    line = map.findIndex((row, index) => index > line && row.trim() !== "")
  }
  const target = firstTopic(map[line]!)!
  expect(map[line]).toContain(`Look into ${target}`)
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => !isMap(frame))
  await app.waitForVisualIdle({ quietFrames: 3 })
  const after = app.captureCharFrame().split("\n")
  expect(after[line]).toContain("┃")
  expect(after[line + 1]).toContain(`Look into ${target}`)
}, 30_000)

test("a plugin draws each collapsed turn in its own look; the host keeps the rows, their places and the selection", async () => {
  await using view = await open("map-turn")
  const { app } = view
  const last = id(TURNS - 1, 1)
  await view.openMap((frame) => frame.includes(`Map agent ${last}`))
  const frame = app.captureCharFrame()
  // The slot carries the turn: its kind, first message, line and work, and whether it is the one selected.
  expect(frame).toContain(`Map user ${id(TURNS - 1, 0)} [Look into ${topic(TURNS - 1)}] 0/0`)
  expect(frame).toContain(`Map agent ${last} [Answer about ${topic(TURNS - 1)}.] 2/3`)
  expect(frame.match(/ selected/g)).toHaveLength(1)
  // The host's rhythm stays: a blank line above each prompt.
  const lines = frame.split("\n")
  const prompt = lines.findIndex((line) => line.includes(`Map user ${id(TURNS - 1, 0)}`))
  expect(lines[prompt - 1]!.trim()).toBe("")
  // G selects the newest turn; the host's selection moves, and the plugin hears of it.
  app.mockInput.pressKey("G", { shift: true })
  await app.waitForFrame((frame) =>
    frame.includes(`Map agent ${last} [Answer about ${topic(TURNS - 1)}.] 2/3 selected`),
  )
}, 30_000)
