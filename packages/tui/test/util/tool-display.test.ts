import { describe, expect, test } from "bun:test"
import {
  canonicalToolName,
  finiteNumber,
  primitiveInputSummary,
  shellActionSummary,
  toolDisplayMetadata,
  webSearchProviderLabel,
} from "../../src/util/tool-display"

test("normalizes shared tool primitives", () => {
  expect(["bash", "task", "apply_patch", "plugin_tool"].map(canonicalToolName)).toEqual([
    "shell",
    "subagent",
    "patch",
    "plugin_tool",
  ])
  expect([finiteNumber(-1.5), finiteNumber(Number.NaN), finiteNumber("1")]).toEqual([-1.5, undefined, undefined])
  expect(primitiveInputSummary({ command: "pwd", count: 2, nested: {} })).toBe("[command=pwd, count=2]")
  expect(primitiveInputSummary({ path: "src/a.ts", line: 2 }, ["path"])).toBe("[line=2]")
})

test("names a shell call that acts on a handle by its action, and an older transcript's flag form the same", () => {
  expect(shellActionSummary({ command: "pwd" })).toBeUndefined()
  expect(shellActionSummary({ action: "run", command: "pwd" })).toBeUndefined()
  expect(shellActionSummary({ action: "check", id: "sh_1" })).toBe("Checked sh_1")
  expect(shellActionSummary({ action: "wait", id: "sh_1", ms: 500 })).toBe("Waited on sh_1")
  expect(shellActionSummary({ action: "kill", id: "sh_1" })).toBe("Killed sh_1")
  expect(shellActionSummary({ action: "list" })).toBe("Listed shells")
  // The flag forms before actions.
  expect(shellActionSummary({ id: "sh_1" })).toBe("Checked sh_1")
  expect(shellActionSummary({ id: "sh_1", wait: 500 })).toBe("Waited on sh_1")
  expect(shellActionSummary({ id: "sh_1", kill: true })).toBe("Killed sh_1")
  expect(shellActionSummary({ list: true })).toBe("Listed shells")
})

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Web Search via Parallel")
    expect(webSearchProviderLabel("exa")).toBe("Web Search via Exa")
    expect(webSearchProviderLabel("firecrawl")).toBe("Web Search via Firecrawl")
    expect(webSearchProviderLabel("tavily")).toBe("Web Search via Tavily")
    expect(webSearchProviderLabel("opencode")).toBe("Web Search via OpenCode")
  })

  test("labels providers dynamically", () => {
    expect(webSearchProviderLabel("other")).toBe("Web Search via Other")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an empty string", ""],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns tool metadata for non-pending states", () => {
    const metadata = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", metadata })).toBe(metadata)
    expect(toolDisplayMetadata({ status: "completed", metadata })).toBe(metadata)
    expect(toolDisplayMetadata({ status: "error", metadata })).toBe(metadata)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "streaming", metadata: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})
