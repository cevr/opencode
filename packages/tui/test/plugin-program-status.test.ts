import { expect, test } from "bun:test"
import type { ProgramStatus } from "@opentui/core"
import { createRoot } from "solid-js"
import { createProgramStatusClaims } from "../src/context/program-status"
import { createPluginContext, type Registry, type usePluginHost } from "../src/plugin/api"

type Host = ReturnType<typeof usePluginHost>

function setup() {
  return createRoot(() => {
    const reports: ProgramStatus[] = []
    const claims = createProgramStatusClaims({
      setProgramStatus(status) {
        reports.push(status)
        return true
      },
    })
    const registry: Registry = { has: () => false, set: () => {}, remove: () => {}, active: () => true }
    const host = {
      app: { version: "test", channel: "test" },
      client: { api: {} },
      keymap: {},
      shortcuts: {},
      keymapState: {},
      sessionTabs: { claimProgramStatus: claims.claim },
    } as unknown as Host
    const owned: Array<() => Promise<void>> = []
    const context = createPluginContext({ host, id: "test", options: undefined, owned, registry })
    return { reports, claims, context, dispose: () => Promise.all(owned.map((run) => run())) }
  })
}

test("a plugin's claim holds program status until the plugin is disposed", async () => {
  const harness = setup()
  const claim = harness.context.ui.programStatus.claim()
  expect(harness.claims.claimed()).toBe(true)
  expect(claim.report({ state: "working", app: "opencode", title: "thinking" })).toBe(true)

  await harness.dispose()
  expect(harness.claims.claimed()).toBe(false)
  expect(claim.report({ state: "idle" })).toBe(false)
  expect(harness.reports).toEqual([
    { state: "clear" },
    { state: "working", app: "opencode", title: "thinking" },
    { state: "clear" },
  ])
})
