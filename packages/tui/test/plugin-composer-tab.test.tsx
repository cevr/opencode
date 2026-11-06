import { expect, test } from "bun:test"
import type { ComposerTab } from "@opencode/plugin/tui/context"
import { createPluginContext, type Registry, type RegistryKind, type usePluginHost } from "../src/plugin/api"
import { createAppFixture } from "./fixture/app"
import { copyPlugin } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

type Host = ReturnType<typeof usePluginHost>

function setup() {
  const entries = new Map<string, unknown>()
  const registry: Registry = {
    has: (kind: RegistryKind, name: string) => entries.has(`${kind}:${name}`),
    set: (kind: RegistryKind, name: string, value: unknown) => void entries.set(`${kind}:${name}`, value),
    remove: (kind: RegistryKind, name: string) => void entries.delete(`${kind}:${name}`),
    active: () => true,
  }
  const host = {
    app: { version: "test", channel: "test" },
    client: { api: {} },
    keymap: {},
    shortcuts: {},
    keymapState: {},
    sessionTabs: {},
  } as unknown as Host
  const context = createPluginContext({ host, id: "test", options: undefined, owned: [], registry })
  return { entries, composerTab: context.ui.composerTab }
}

const tab = (id: string): ComposerTab => ({ id, title: "Probe", render: () => null })

test("registers a tab under its id until the cleanup runs", () => {
  const harness = setup()
  const dispose = harness.composerTab(tab("probe"))
  expect(harness.entries.get("composer:probe")).toMatchObject({ id: "probe", title: "Probe" })
  dispose()
  expect(harness.entries.has("composer:probe")).toBe(false)
})

test.each(["subagents", "shell", "terminals"])("refuses the host's own tab id %j", (id) => {
  expect(() => setup().composerTab(tab(id))).toThrow("Composer tab id is the host's own")
})

test.each(["", "a b", "x/y"])("refuses the id %j", (id) => {
  expect(() => setup().composerTab(tab(id))).toThrow("Composer tab id must be")
})

test("refuses a second tab with one id from the same plugin", () => {
  const harness = setup()
  harness.composerTab(tab("probe"))
  expect(() => harness.composerTab(tab("probe"))).toThrow("Composer tab already registered: probe")
})

const session = {
  id: "ses_composer_tab",
  title: "Composer tab",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const messages = [{ type: "user", id: "msg_ask", text: "Fix the parser", time: { created: 1 } }]

test("a plugin's tab follows the host's in the panel ↓ opens, its keys act while it is active, and it unmounts when the panel closes", async () => {
  const fixture = await copyPlugin("composer-tab")
  try {
    await using app = await createAppFixture({
      width: 100,
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
    await app.waitForFrame((frame) => frame.includes("Fix the parser"))
    app.mockInput.pressArrow("down")
    const panel = await app.waitForFrame((frame) => frame.includes("Subagents") && frame.includes("Probe"))
    const tabs = panel.split("\n").find((line) => line.includes("Subagents"))!
    expect(tabs.indexOf("Probe")).toBeGreaterThan(tabs.indexOf("Shell"))
    // Its content mounts only while it is the active tab.
    expect(panel).not.toContain("Probe for")
    for (let step = 0; step < 4 && !app.captureCharFrame().includes("Probe for"); step++) {
      app.mockInput.pressArrow("right")
      await Bun.sleep(50)
    }
    await app.waitForFrame((frame) => frame.includes(`Probe for ${session.id}: 0`) && frame.includes("count ctrl+d"))
    app.mockInput.pressKey("d", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes(`Probe for ${session.id}: 1`))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("Probe for") && !frame.includes("Subagents"))
  } finally {
    await fixture[Symbol.asyncDispose]()
  }
})
