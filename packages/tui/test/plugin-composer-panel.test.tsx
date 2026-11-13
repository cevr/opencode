import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { copyPlugin } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

const session = (id: string, title: string, parentID?: string) => ({
  id,
  ...(parentID ? { parentID } : {}),
  title,
  agent: "build",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
})
const parent = session("ses_panel_parent", "Parent session")
const first = session("ses_panel_first", "Fix the parser", parent.id)
const second = session("ses_panel_second", "Write the docs", parent.id)
const sessions = [parent, first, second]
const messages = [{ type: "user", id: "msg_ask", text: "Split the work", time: { created: 1 } }]

// A plugin takes over the panel's tab bar, each row and the footer through the
// three slots; the host keeps the panel's keys, so ↓ and → still act and the
// slots' inputs follow them.
test("a plugin draws the panel's tab bar, rows and footer from the slots' inputs", async () => {
  const fixture = await copyPlugin("composer-panel")
  try {
    await using app = await createAppFixture({
      width: 120,
      height: 30,
      config: { animations: false, tabs: { enabled: false }, plugins: [fixture.directory] },
      args: { sessionID: parent.id },
      fetch: (url) => {
        if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
        // Both subagents run, so the Subagents tab's active filter lists them.
        if (url.pathname === "/api/session/active")
          return json({ data: { [first.id]: { type: "running" }, [second.id]: { type: "running" } } })
        if (url.pathname === `/api/session/${parent.id}/family/request`)
          return json({ data: { sessions: sessions.map((each) => each.id), permissions: [], forms: [] } })
        for (const each of sessions) if (url.pathname === `/api/session/${each.id}`) return json({ data: each })
        if (url.pathname.endsWith("/message"))
          return json({ data: url.pathname.includes(parent.id) ? messages : [], cursor: {} })
        if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
        return undefined
      },
    })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("Split the work"))
    app.mockInput.pressArrow("down")
    const rows = await app.waitForFrame(
      (frame) => frame.includes(`Row subagents ${second.id}`) && frame.includes("Footer"),
    )
    expect(rows).toContain("Tabs subagents|shell|terminals active subagents open")
    // The host's own tab bar is gone: its `esc` was the only one.
    expect(rows).not.toContain("esc")
    expect(rows).toContain(`Row subagents ${first.id} of 2 "Build: Fix the parser" selected`)
    expect(rows).toContain(`Row subagents ${second.id} of 2 "Build: Write the docs"`)
    expect(rows).not.toContain(`"Build: Write the docs" selected`)
    expect(rows).toMatch(/Footer interrupt=\S+,show inactive=ctrl\+a tabs 3/)
    // ↓ moves the highlight; the row inputs follow it.
    app.mockInput.pressArrow("down")
    await app.waitForFrame(
      (frame) =>
        frame.includes(`"Build: Write the docs" selected`) && !frame.includes(`"Build: Fix the parser" selected`),
    )
    // → moves to the Shell tab; the tab bar's input follows.
    app.mockInput.pressArrow("right")
    await app.waitForFrame((frame) => frame.includes("active shell") && frame.includes("No shell commands"))
  } finally {
    await fixture[Symbol.asyncDispose]()
  }
})
