import { expect, test } from "bun:test"
import { getTreeSitterClient } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

// A finished reply's markdown is drawn the frame it mounts, before the syntax highlighter answers. On a busy host
// the highlighter's worker answers seconds late (rows scrolled into view stayed blank under their bullets); here it
// never answers at all.
test("a finished reply paints its text before highlighting", async () => {
  const session = {
    id: "ses_markdown_first_paint",
    title: "Markdown first paint",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "msg_000001_0", text: "What is PARK's order?", time: { created: 0 } },
    {
      type: "assistant",
      id: "msg_000001_1",
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      finish: "stop",
      time: { created: 1, completed: 2 },
      content: [
        {
          type: "text",
          text: [
            "PARK finished the unit.",
            "",
            "- **Checks:** a new test holds a sleep at zero allocations.",
            "- **Not folded in:** timer-task reuse.",
            "",
            "**PARK's order:**",
            "",
            "1. The settle step on the park word.",
            "2. Reusing the `handle`.",
          ].join("\n"),
        },
      ],
    },
  ]
  const client = getTreeSitterClient()
  const highlightOnce = client.highlightOnce.bind(client)
  client.highlightOnce = () => new Promise(() => {})
  try {
    await using app = await createAppFixture({
      args: { sessionID: session.id },
      config: { animations: false },
      fetch: async (url) => {
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${session.id}/message`)
          return json({ data: messages.toReversed(), cursor: {} })
        if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/permission")) return json({ data: [] })
      },
    })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("What is PARK's order?"))
    await app.waitForVisualIdle({ quietFrames: 3 })
    const frame = app.captureCharFrame()
    expect(frame).toContain("PARK finished the unit.")
    expect(frame).toContain("Checks: a new test holds a sleep at zero allocations.")
    expect(frame).toContain("PARK's order:")
    expect(frame).toContain("1. The settle step on the park word.")
    expect(frame).toContain("2. Reusing the handle.")
  } finally {
    client.highlightOnce = highlightOnce
  }
}, 30_000)
