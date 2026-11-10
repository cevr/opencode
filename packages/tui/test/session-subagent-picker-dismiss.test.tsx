import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

// A subagent's view opens on its Subagents picker. Escape puts the picker away and leaves the view on the subagent,
// with the prompt focused, so a message steers that subagent; Down on the empty prompt brings the picker back.
test("Escape dismisses a subagent's picker to its prompt, without leaving the subagent", async () => {
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
  const parent = session("ses_picker_parent", "Parent session")
  const child = session("ses_picker_child", "Child session", parent.id)
  const messages = [{ id: "message-1", type: "user", text: "Child brief", time: { created: 1 } }]
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { mode: "off" } },
    args: { sessionID: child.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [parent, child], cursor: {} })
      if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
      if (url.pathname === `/api/session/${parent.id}`) return json({ data: parent })
      if (url.pathname.endsWith("/message"))
        return json({ data: url.pathname.includes(child.id) ? messages : [], cursor: {} })
      if (url.pathname.endsWith("/inbox")) return json({ data: [] })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Child brief") && frame.includes("Subagents"))

  setup.mockInput.pressEscape()
  const dismissed = await setup.waitForFrame((frame) => frame.includes("Child brief") && !frame.includes("Subagents"))
  expect(dismissed).toContain("Child brief")

  await setup.mockInput.typeText("steer it")
  expect(await setup.waitForFrame((frame) => frame.includes("steer it"))).toContain("Child brief")

  // Down on an empty prompt opens the picker again; Escape puts it away again.
  for (let index = 0; index < "steer it".length; index++) setup.mockInput.pressBackspace()
  await setup.waitForFrame((frame) => !frame.includes("steer it"))
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("Subagents"))
  setup.mockInput.pressEscape()
  expect(await setup.waitForFrame((frame) => !frame.includes("Subagents"))).toContain("Child brief")
})
