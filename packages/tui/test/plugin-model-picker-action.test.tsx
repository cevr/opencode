import { afterEach, expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import type { ModelPickerAction } from "@opencode/plugin/tui/context"
import {
  createPluginContext,
  type RegisteredModelPickerAction,
  type Registry,
  type RegistryKind,
  type usePluginHost,
} from "../src/plugin/api"
import { createAppFixture } from "./fixture/app"
import { copyPlugin, tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

type Host = ReturnType<typeof usePluginHost>
type Probe = { triggers: { providerID: string; modelID: string }[]; dispose?: () => void }
const probe = () => (globalThis as { __modelPickerProbe?: Probe }).__modelPickerProbe

afterEach(() => {
  delete (globalThis as { __modelPickerProbe?: Probe }).__modelPickerProbe
})

function setup() {
  const entries = new Map<string, unknown>()
  const toasts: unknown[] = []
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
    toast: { show: (toast: unknown) => void toasts.push(toast) },
  } as unknown as Host
  const context = createPluginContext({ host, id: "test", options: undefined, owned: [], registry })
  return { entries, toasts, modelPickerAction: context.ui.modelPickerAction }
}

const action = (id: string, onTrigger: ModelPickerAction["onTrigger"] = () => {}): ModelPickerAction => ({
  id,
  bind: "ctrl+g",
  title: "Probe",
  onTrigger,
})

test("registers an action under its id, with a command named for the plugin, until the cleanup runs", () => {
  const harness = setup()
  const dispose = harness.modelPickerAction(action("queue"))
  expect(harness.entries.get("modelPicker:queue")).toMatchObject({
    id: "queue",
    bind: "ctrl+g",
    title: "Probe",
    command: "plugin.test.model-picker.queue",
  })
  dispose()
  expect(harness.entries.has("modelPicker:queue")).toBe(false)
})

test.each(["", "a b", "x/y"])("refuses the id %j", (id) => {
  expect(() => setup().modelPickerAction(action(id))).toThrow("Model picker action id must be")
})

test("refuses a second action with one id from the same plugin", () => {
  const harness = setup()
  harness.modelPickerAction(action("queue"))
  expect(() => harness.modelPickerAction(action("queue"))).toThrow("Model picker action already registered: queue")
})

test("an action that throws shows one error toast instead of failing the picker", () => {
  const harness = setup()
  harness.modelPickerAction(
    action("queue", () => {
      throw new Error("no queue")
    }),
  )
  const registered = harness.entries.get("modelPicker:queue") as RegisteredModelPickerAction
  expect(() => registered.onTrigger({ providerID: "demo", modelID: "second" })).not.toThrow()
  expect(harness.toasts).toEqual([
    { variant: "error", title: "Plugin", message: "test failed in the model picker: no queue" },
  ])
})

const session = {
  id: "ses_model_picker_action",
  projectID: "project",
  title: "Model picker action",
  agent: "build",
  model: { providerID: "demo", id: "first" },
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

/** The app on a session over two models, the picker on F8; `plugins` are fixture plugin directories. */
async function openApp(plugins: string[]) {
  const state = await tmpdir()
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const mutations: string[] = []
  const app = await createAppFixture({
    state: state.path,
    width: 100,
    height: 30,
    config: { animations: false, tabs: { enabled: false }, keybinds: { "model.list": "f8" }, plugins },
    args: { sessionID: session.id },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: ["first", "second"].map((id) => ({
            id,
            providerID: "demo",
            name: `${id} model`,
            variants: [],
            cost: [],
            time: { released: 0 },
          })),
        })
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      // A model switch would reach the server as a session mutation.
      if (request.method !== "GET" && url.pathname.startsWith("/api/session/")) mutations.push(url.pathname)
      return undefined
    },
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("first model"))
  return {
    app,
    mutations,
    async openPicker() {
      app.mockInput.pressKey("F8")
      await app.waitForFrame(
        (frame) => frame.includes("Select model") && app.renderer.currentFocusedRenderable instanceof InputRenderable,
      )
    },
    async [Symbol.asyncDispose]() {
      await app[Symbol.asyncDispose]()
      await state[Symbol.asyncDispose]()
    },
  }
}

test("a plugin's picker action is listed in the footer and acts on the highlighted model, leaving the picker open", async () => {
  const fixture = await copyPlugin("model-picker-action")
  try {
    await using harness = await openApp([fixture.directory])
    const { app } = harness
    await harness.openPicker()
    await app.waitForFrame((frame) => frame.includes("queue next"))

    await app.mockInput.typeText("second")
    await app.renderOnce()
    app.mockInput.pressKey("g", { ctrl: true })
    await app.waitFor(() => (probe()?.triggers.length ?? 0) > 0)

    expect(probe()?.triggers).toEqual([{ providerID: "demo", modelID: "second" }])
    // The picker stays open and nothing was selected: no model switch reached the server.
    const frame = app.captureCharFrame()
    expect(frame).toContain("Select model")
    expect(harness.mutations).toEqual([])

    // The cleanup takes it out of the open picker, and its key does nothing more.
    probe()?.dispose?.()
    await app.waitForFrame((frame) => frame.includes("Select model") && !frame.includes("queue next"))
    app.mockInput.pressKey("g", { ctrl: true })
    await app.renderOnce()
    expect(probe()?.triggers).toHaveLength(1)
    expect(harness.mutations).toEqual([])
  } finally {
    await fixture[Symbol.asyncDispose]()
  }
})

test("with no plugin action the picker footer keeps only the host's actions", async () => {
  await using harness = await openApp([])
  await harness.openPicker()
  const frame = await harness.app.waitForFrame((frame) => frame.includes("Favorite"))
  expect(frame).not.toContain("queue next")
  expect(probe()).toBeUndefined()
})
