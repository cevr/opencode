import { expect, test } from "bun:test"
import type { AutocompleteSource } from "@opencode/plugin/tui/context"
import { createPluginContext, type Registry, type RegistryKind, type usePluginHost } from "../src/plugin/api"

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
  return { entries, autocomplete: context.ui.autocomplete }
}

const source = (trigger: string): AutocompleteSource => ({ trigger, options: () => [{ value: "tdd" }] })

test("registers a popup under its trigger until the cleanup runs", () => {
  const harness = setup()
  const dispose = harness.autocomplete(source("$"))
  expect(harness.entries.get("autocomplete:$")).toMatchObject({ trigger: "$" })
  dispose()
  expect(harness.entries.has("autocomplete:$")).toBe(false)
})

test.each(["/", "@", "", "$$", " "])("refuses the trigger %j", (trigger) => {
  expect(() => setup().autocomplete(source(trigger))).toThrow("Autocomplete trigger must be one character")
})

test("refuses a second popup for one trigger from the same plugin", () => {
  const harness = setup()
  harness.autocomplete(source("$"))
  expect(() => harness.autocomplete(source("$"))).toThrow("Autocomplete trigger already registered: $")
})
