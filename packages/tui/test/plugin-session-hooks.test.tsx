import { rgbToHex } from "@opentui/core"
import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { copyPlugin } from "./fixture/fixture"
import { waitForHighlightedFrame } from "./fixture/frame"
import { directory, json } from "./fixture/tui-client"

const session = {
  id: "ses_plugin_hooks",
  title: "Plugin hooks",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const model = { providerID: "fixture", id: "fixture" }
// Newest first, as the server pages them.
const messages = [
  {
    type: "assistant",
    id: "msg_reply",
    agent: "build",
    model,
    finish: "stop",
    time: { created: 2, completed: 3 },
    // 2,000 tokens of a 8,000-token window.
    tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 800, write: 0 } },
    content: [
      { type: "reasoning", text: "Weighing the parser fix", time: { created: 2, completed: 2 } },
      {
        type: "tool",
        id: "call_shell",
        name: "bash",
        time: { created: 2, completed: 3 },
        state: {
          status: "completed",
          input: { command: "bun test parser" },
          content: [{ type: "text", text: "1 pass" }],
          metadata: {},
        },
      },
      { type: "text", text: "The **parser** is fixed.\n\n```probe\nanything\n```" },
    ],
  },
  { type: "user", id: "msg_ask", text: "Fix the parser", time: { created: 1 } },
]

async function openSession(
  plugin: string,
  history: ReadonlyArray<unknown> = messages,
  inbox: ReadonlyArray<unknown> = [],
) {
  const fixture = await copyPlugin(plugin)
  const setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { enabled: false }, plugins: [fixture.directory] },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: history, cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: inbox })
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
      if (url.pathname === "/api/model")
        return json({
          location: { directory, project: { id: "proj_test", directory, canonical: directory } },
          data: [{ ...model, name: "Fixture", variants: [], limit: { context: 8000, output: 1000 } }],
        })
      return undefined
    },
  })
  const dispose = setup[Symbol.asyncDispose]
  return Object.assign(setup, {
    async [Symbol.asyncDispose]() {
      await dispose()
      await fixture[Symbol.asyncDispose]()
    },
  })
}

test("a plugin renders host markdown", async () => {
  await using app = await openSession("session-reads")
  await app.ready
  // ui.Markdown conceals the markup and runs registered fence renderers.
  const frame = await waitForHighlightedFrame(
    app,
    (frame) => frame.includes("Read text:0: The parser is fixed.") && frame.includes("Probe fence rendered"),
  )
  expect(frame).not.toContain("**parser**")
  expect(frame).not.toContain("```")
})

test("a plugin sets transcript defaults", async () => {
  await using app = await openSession("tool-renderer")
  await app.ready
  // grouping "none" keeps the call its own row.
  // thinking "show" expands reasoning the host hides by default.
  await waitForHighlightedFrame(
    app,
    (frame) =>
      frame.includes("Custom shell row: bun test parser") &&
      frame.includes("Weighing the parser fix") &&
      frame.includes("The parser is fixed."),
  )
})

test("the user's transcript config wins over a plugin's defaults", async () => {
  const fixture = await copyPlugin("tool-renderer")
  try {
    await using app = await createAppFixture({
      width: 100,
      height: 30,
      config: {
        animations: false,
        tabs: { enabled: false },
        plugins: [fixture.directory],
        session: { thinking: "hide" },
      },
      args: { sessionID: session.id },
      fetch: (url) => {
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
        if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
        return undefined
      },
    })
    await app.ready
    const frame = await app.waitForFrame((frame) => frame.includes("Custom shell row: bun test parser"))
    expect(frame).not.toContain("Weighing the parser fix")
  } finally {
    await fixture[Symbol.asyncDispose]()
  }
})

test("a plugin claims the transcript's header, first and last rows, user prompt and turn footer", async () => {
  await using app = await openSession("transcript-chrome")
  await app.ready
  const frame = await waitForHighlightedFrame(
    app,
    (frame) =>
      frame.includes("Header claimed") &&
      frame.includes("Transcript start claimed") &&
      frame.includes("User band: Fix the parser") &&
      frame.includes("The parser is fixed.") &&
      frame.includes("Footer for msg_reply") &&
      frame.includes("Transcript end: const answer = 42"),
  )
  const lines = frame.split("\n")
  // The last row follows the newest turn's footer, one row gap apart; ui.Code draws the source as written.
  const end = lines.findIndex((line) => line.includes("Transcript end"))
  expect(end).toBeGreaterThan(lines.findIndex((line) => line.includes("Footer for msg_reply")))
  // inset 1 starts rows one cell in.
  expect(lines.find((line) => line.includes("User band"))).toStartWith(" User band")
  // rowGap 0 for the footer puts it straight under the reply; every other row keeps one blank row above it.
  const footer = lines.findIndex((line) => line.includes("Footer for msg_reply"))
  expect(lines[footer - 1]).toContain("anything")
  const user = lines.findIndex((line) => line.includes("User band"))
  expect(lines[user - 1]?.trim()).toBe("")
})

test("a layout rule sees the row's message, so a message a slot hides takes no space", async () => {
  await using app = await openSession("hidden-message")
  await app.ready
  const frame = await waitForHighlightedFrame(
    app,
    (frame) => frame.includes("Transcript start claimed") && frame.includes("The parser is fixed."),
  )
  const lines = frame.split("\n")
  const start = lines.findIndex((line) => line.includes("Transcript start claimed"))
  // The hidden prompt adds no row: one blank row (the reply's own gap), then the reply.
  expect(lines[start + 1]?.trim()).toBe("")
  expect(lines[start + 2]?.trim()).not.toBe("")
})

const queued = [
  {
    id: "msg_queued",
    sessionID: session.id,
    type: "user",
    delivery: "queue",
    payload: { text: "Queued follow-up" },
    time: { created: 4 },
  },
]

test("the host draws its queued-prompts box above the composer while a prompt waits for the turn", async () => {
  await using app = await openSession("session-reads", messages, queued)
  await app.ready
  await waitForHighlightedFrame(app, (frame) => frame.includes("1 queued · Queued follow-up"))
})

test("a plugin replaces the queued-prompts box, and the host's box is not drawn", async () => {
  await using app = await openSession("queued-box", messages, queued)
  await app.ready
  const frame = await waitForHighlightedFrame(app, (frame) => frame.includes("Queued box: Queued follow-up"))
  expect(frame).not.toContain("1 queued")
})

test("a plugin picks the bare rail composer", async () => {
  await using app = await openSession("composer-rail")
  await app.ready
  const frame = await waitForHighlightedFrame(app, (frame) => frame.includes("The parser is fixed."))
  const lines = frame.split("\n")
  // An empty draft is a bare rail: no fill, padding or metadata row before the footer.
  const rail = lines.findLastIndex((line) => /^ *┃ *$/.test(line))
  expect(rail).toBeGreaterThan(-1)
  expect(lines[rail + 1]).toContain("ctrl+p commands")
  // The rail is drawn in the text colour, as the reply's prose is in the default theme.
  const spans = app.captureSpans().lines
  const color = (y: number, text: string) => spans[y]!.spans.find((span) => span.text.includes(text))!.fg
  const prose = spans.findIndex((line) => line.spans.some((span) => span.text.includes("is fixed")))
  expect(rgbToHex(color(rail, "┃"))).toBe(rgbToHex(color(prose, "is fixed")))
})

test("a plugin claims completion notices, and layout rules see notices as their own kind", async () => {
  const notice = (id: string, created: number, metadata: Record<string, unknown>, description: string) => ({
    type: "synthetic",
    id,
    text: "Notice",
    description,
    metadata,
    time: { created },
  })
  // Newest first, as the server pages them.
  const history = [
    notice("msg_goal", 6, { source: "goal" }, "Goal updated"),
    notice("msg_done_b", 5, { source: "subagent", state: "completed", agent: "worker", childID: "ses_b" }, "Fix b"),
    notice("msg_done_a", 4, { source: "subagent", state: "completed", agent: "worker", childID: "ses_a" }, "Fix a"),
    ...messages,
  ]
  await using app = await openSession("completion-notice", history)
  await app.ready
  const frame = await waitForHighlightedFrame(
    app,
    (frame) => frame.includes("Completion claimed: msg_done_b") && frame.includes("Goal updated"),
  )
  const lines = frame.split("\n")
  const first = lines.findIndex((line) => line.includes("Completion claimed: msg_done_a"))
  // Each completion is the plugin's; notices after notices stack with no blank row between them.
  expect(first).toBeGreaterThan(lines.findIndex((line) => line.includes("The parser is fixed.")))
  expect(lines[first + 1]).toContain("Completion claimed: msg_done_b")
  // Other notices keep the host's own row.
  expect(lines[first + 2]).toContain("Goal updated")
  expect(frame).not.toContain("Worker finished")
})

test("a plugin follows whether the session's sidebar is visible", async () => {
  const fixture = await copyPlugin("sidebar-visible")
  try {
    await using app = await createAppFixture({
      // Past the 120 columns at which the auto sidebar opens.
      width: 160,
      height: 30,
      config: { animations: false, tabs: { enabled: false }, plugins: [fixture.directory] },
      args: { sessionID: session.id },
      fetch: (url) => {
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
        if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
        return undefined
      },
    })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("Sidebar probe: shown"))
    app.resize(100, 30)
    await app.waitForFrame((frame) => frame.includes("Sidebar probe: hidden"))
    app.resize(160, 30)
    await app.waitForFrame((frame) => frame.includes("Sidebar probe: shown"))
  } finally {
    await fixture[Symbol.asyncDispose]()
  }
})

test("a plugin sees the sidebar hidden when the user hides it on a wide terminal", async () => {
  const fixture = await copyPlugin("sidebar-visible")
  try {
    await using app = await createAppFixture({
      width: 160,
      height: 30,
      config: {
        animations: false,
        tabs: { enabled: false },
        plugins: [fixture.directory],
        session: { sidebar: "hide" },
      },
      args: { sessionID: session.id },
      fetch: (url) => {
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
        if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
        return undefined
      },
    })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("Sidebar probe: hidden"))
  } finally {
    await fixture[Symbol.asyncDispose]()
  }
})

test("a plugin draws over the transcript's top row, follows the scroll and reveals a message", async () => {
  // Forty prompts, far taller than the 30-row terminal.
  const history = Array.from({ length: 40 }, (_, index) => ({
    type: "user",
    id: `message-${index}`,
    text: `Prompt ${index}`,
    time: { created: index },
  })).toReversed()
  await using app = await openSession("transcript-overlay", history)
  await app.ready
  await app.waitForFrame((frame) => frame.includes("Prompt 39") && frame.includes("Overlay away=false"))
  const overlayIndex = () =>
    app
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Overlay"))
  const firstRow = (frame: string) => frame.split("\n").find((line) => line.includes("Overlay")) ?? ""
  // The overlay is the transcript's first row, under the session header's one row at most.
  expect(overlayIndex()).toBeLessThan(2)

  for (const _ of Array.from({ length: 6 })) await app.mockMouse.scroll(10, 10, "up")
  const away = await app.waitForFrame((frame) => frame.includes("Overlay away=true"))
  // The top row names the prompt at or above it, with its row (0 or above the viewport).
  const top = firstRow(away).match(/top=message-(\d+)@(-?\d+)/)
  expect(top).not.toBeNull()
  expect(Number(top?.[2])).toBeLessThanOrEqual(0)

  await app.mockMouse.click(10, overlayIndex())
  // message-5's first row is now the viewport's top row.
  await app.waitForFrame((frame) => firstRow(frame).includes("top=message-5@0") && firstRow(frame).includes("target=0"))
})

test("a plugin claims compactions in place of the host's rule and summary", async () => {
  const usage = { input: 170_000, output: 6_000, reasoning: 0, cache: { read: 1_000, write: 0 } }
  // Newest first, as the server pages them.
  const history = [
    {
      type: "compaction",
      id: "msg_compacted",
      status: "completed",
      reason: "auto",
      summary: "The summary the plugin hides",
      tokens: usage,
      time: { created: 5 },
    },
    ...messages,
  ]
  await using app = await openSession("compaction-row", history)
  await app.ready
  const frame = await app.waitForFrame((frame) => frame.includes("Compaction claimed: msg_compacted completed"))
  // The rest of the transcript keeps the host's rows.
  expect(frame).toContain("$ bun test parser")
  expect(frame).not.toContain("Automatic compaction")
  expect(frame).not.toContain("The summary the plugin hides")
})
