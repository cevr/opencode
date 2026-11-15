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
const parent = session("ses_picker_parent", "Parent session")
const child = session("ses_picker_child", "Child session", parent.id)
const messages = [{ id: "message-1", type: "user", text: "Child brief", time: { created: 1 } }]

/** The child's view, with the plugins in `plugins` loaded by directory. */
const openChild = (plugins: ReadonlyArray<string> = []) =>
  createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { mode: "off" }, plugins: [...plugins] },
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

// A subagent's view opens on its Subagents picker. Escape puts the picker away and leaves the view on the subagent,
// with the prompt focused, so a message steers that subagent; Down on the empty prompt brings the picker back.
test("Escape dismisses a subagent's picker to its prompt, without leaving the subagent", async () => {
  await using setup = await openChild()
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

// The layout's `composer.subagentPicker: "closed"`: the view opens on the prompt, and Down still shows the picker.
test("a plugin has a subagent's view open on its prompt, the picker one Down away and Up past its top back", async () => {
  await using fixture = await copyPlugin("subagent-picker-closed")
  await using setup = await openChild([fixture.directory])
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Child brief") && !frame.includes("Subagents"))

  // Up past the first row of the panel Down opened puts it away over the prompt; the view stays on the subagent
  // (where the picker that is the view itself goes back to the parent).
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("Subagents"))
  setup.mockInput.pressArrow("up")
  expect(await setup.waitForFrame((frame) => !frame.includes("Subagents"))).toContain("Child brief")

  // The prompt has the keyboard: what is typed lands there.
  await setup.mockInput.typeText("steer it")
  expect(await setup.waitForFrame((frame) => frame.includes("steer it"))).not.toContain("Subagents")

  for (let index = 0; index < "steer it".length; index++) setup.mockInput.pressBackspace()
  await setup.waitForFrame((frame) => !frame.includes("steer it"))
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("Subagents"))
  setup.mockInput.pressEscape()
  expect(await setup.waitForFrame((frame) => !frame.includes("Subagents"))).toContain("Child brief")
})
