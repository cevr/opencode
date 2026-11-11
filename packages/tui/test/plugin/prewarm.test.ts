import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import "../../src/plugin/runtime-plugin-support.bun"
import { prewarmPlugins } from "../../src/plugin/prewarm"
import { createPluginSources } from "../../src/plugin/source"
import { tmpdir } from "../fixture/fixture"

test("a prewarmed local plugin is imported once, and the provider's read finds it loaded", async () => {
  await using temporary = await tmpdir()
  const plugin = path.join(temporary.path, "plugin")
  const counter = `__prewarm_${crypto.randomUUID().replaceAll("-", "")}`
  await Bun.write(
    path.join(plugin, "tui.ts"),
    `globalThis.${counter} = (globalThis.${counter} ?? 0) + 1; export default "loaded"`,
  )
  const counted = () => (globalThis as Record<string, unknown>)[counter]

  // Packages, disabled entries and missing paths are skipped without a failure.
  prewarmPlugins([plugin, "-" + plugin, "some-package", path.join(temporary.path, "missing")], temporary.path)
  const entry = pathToFileURL(path.join(plugin, "tui.ts")).href
  for (let waited = 0; counted() === undefined && waited < 2_000; waited += 10) await Bun.sleep(10)
  expect(counted()).toBe(1)

  // The provider reads through its own sources, and finds the same evaluation.
  const read = await createPluginSources(async () => {}).read(entry)
  expect(read.module).toMatchObject({ default: "loaded" })
  expect(counted()).toBe(1)
})
