import { rgbToHex } from "@opentui/core"
import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { waitForHighlightedFrame } from "./fixture/frame"
import { directory, json } from "./fixture/tui-client"

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_markdown_text",
  title: "Markdown text",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
// Newest first, as the server pages them.
const messages = [
  {
    type: "assistant",
    id: "msg_reply",
    agent: "build",
    model: { providerID: "provider", id: "model" },
    finish: "stop",
    time: { created: 2, completed: 3 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ type: "text", text: "Plain prose in the reply." }],
  },
  { type: "user", id: "msg_ask", text: "Say something", time: { created: 1 } },
]

// The stock theme with prose a different colour from other text, as custom themes set it.
const PROSE = "#c0ffee"
const stock = await Bun.file(new URL("../src/theme/assets/opencode.json", import.meta.url)).json()
const theme = { ...stock, theme: { ...stock.theme, markdownText: { dark: PROSE, light: PROSE } } }

test("assistant prose renders in the theme's markdown text colour", async () => {
  await using app = await createAppFixture({
    args: { sessionID: session.id },
    config: { animations: false, theme: { name: "prose", mode: "dark" } },
    themes: { prose: theme },
    fetch: (url) => {
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
    },
  })
  await waitForHighlightedFrame(app, (frame) => frame.includes("Plain prose in the reply."))
  const span = app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes("Plain prose"))
  expect(span && rgbToHex(span.fg)).toBe(PROSE)
})
