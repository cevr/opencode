import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Host } from "../src/host"
import { createPluginSources } from "../src/source"

// The layout of a plugin repository built from workspace packages: the entry
// imports its code by package name, and the package manager links that name
// into node_modules to a package directory beside the plugin.
const workspace = {
  "package.json": JSON.stringify({ private: true, workspaces: ["plugin", "lib", "other"] }),
  "plugin/package.json": JSON.stringify({ name: "plugin", type: "module" }),
  "plugin/tui.ts": 'export { value } from "@ws/lib"; export { default as dep } from "dep"',
  "plugin/node_modules/dep/package.json": JSON.stringify({ name: "dep", type: "module", main: "index.js" }),
  "plugin/node_modules/dep/index.js": 'export default { dep: "installed" }',
  "lib/package.json": JSON.stringify({ name: "@ws/lib", type: "module", exports: { ".": "./index.ts" } }),
  "lib/index.ts": 'export { value } from "./value"',
  "lib/value.ts": 'export const value = "before"',
}

test("an edit inside a linked workspace package reloads the plugin", async () => {
  await using dir = await fixture(workspace)
  await dir.link("plugin/node_modules/@ws/lib", "lib")
  const before = await dir.sources.read(dir.url("plugin/tui.ts"))
  expect(before.module).toMatchObject({ value: "before" })
  expect(dir.watched).toContain(dir.path("lib/value.ts"))
  await dir.write("lib/value.ts", 'export const value = "after"')
  const after = await dir.sources.read(dir.url("plugin/tui.ts"))
  expect(after.version).not.toBe(before.version)
  expect(after.module).toMatchObject({ value: "after" })
  expect(before.module).toMatchObject({ value: "before" })
})

// A server keeps one set of sources per location: an unchanged local graph is
// evaluated once per process, as an installed package is, and every set
// still watches the graph, so each location hears an edit.
test("sets of sources share one evaluation of an unchanged graph and each watches it", async () => {
  await using dir = await fixture({
    ...workspace,
    "plugin/tui.ts": 'export { value } from "@ws/lib"; export const instance = {}',
  })
  await dir.link("plugin/node_modules/@ws/lib", "lib")
  const watched: string[] = []
  const other = createPluginSources(async (file) => {
    watched.push(file)
  })
  try {
    const first = await dir.sources.read(dir.url("plugin/tui.ts"))
    const second = await other.read(dir.url("plugin/tui.ts"))
    expect(second).toBe(first)
    expect(watched.toSorted()).toEqual(dir.watched.toSorted())
    expect(watched).toContain(dir.path("lib/value.ts"))
    await dir.write("lib/value.ts", 'export const value = "after"')
    const edited = await other.read(dir.url("plugin/tui.ts"))
    expect(edited.module).toMatchObject({ value: "after" })
    expect((edited.module as { instance: unknown }).instance).not.toBe((first.module as { instance: unknown }).instance)
    expect(await dir.sources.read(dir.url("plugin/tui.ts"))).toBe(edited)
  } finally {
    other.dispose()
  }
})

test("installed packages stay outside the source graph and keep their instance", async () => {
  await using dir = await fixture(workspace)
  await dir.link("plugin/node_modules/@ws/lib", "lib")
  const dep = (await Host.load(dir.url("plugin/node_modules/dep/index.js"))) as { default: unknown }
  const before = (await dir.sources.read(dir.url("plugin/tui.ts"))).module as { dep: unknown }
  await dir.write("lib/value.ts", 'export const value = "after"')
  const after = (await dir.sources.read(dir.url("plugin/tui.ts"))).module as { dep: unknown }
  expect(before.dep).toBe(dep.default)
  expect(after.dep).toBe(dep.default)
  expect(dir.watched.some((file) => file.split(path.sep).includes("node_modules"))).toBe(false)
})

test("a package linked from outside the plugin's workspace stays external", async () => {
  await using dir = await fixture({ ...workspace, "package.json": JSON.stringify({ private: true }) })
  await dir.link("plugin/node_modules/@ws/lib", "lib")
  expect((await dir.sources.read(dir.url("plugin/tui.ts"))).module).toMatchObject({ value: "before" })
  expect(dir.watched).not.toContain(dir.path("lib/value.ts"))
})

test("a workspace module the host already loaded keeps the host's instance", async () => {
  await using dir = await fixture({
    ...workspace,
    "plugin/tui.ts": 'export { state } from "@ws/lib/state"; export const generation = 1',
    "lib/package.json": JSON.stringify({ name: "@ws/lib", type: "module", exports: { "./state": "./state.ts" } }),
    "lib/state.ts": "export const state = {}",
  })
  await dir.link("plugin/node_modules/@ws/lib", "lib")
  const host = (await Host.load(dir.url("lib/state.ts"))) as { state: unknown }
  for (const generation of [1, 2]) {
    await dir.write("plugin/tui.ts", `export { state } from "@ws/lib/state"; export const generation = ${generation}`)
    const loaded = (await dir.sources.read(dir.url("plugin/tui.ts"))).module as { state: unknown }
    expect(loaded).toMatchObject({ generation })
    expect(loaded.state).toBe(host.state)
  }
  expect(dir.watched).not.toContain(dir.path("lib/state.ts"))
})

// `bun install --force` relinks workspace packages while the host runs. A
// lookup that failed while the link was missing must not stick: Bun caches the
// directory listings it read for the rest of the process.
test.each([
  ["the entry", ["plugin/node_modules/@ws/lib", "lib"], ["lib/node_modules/@ws/other", "other"]],
  ["a linked package", ["lib/node_modules/@ws/other", "other"], ["plugin/node_modules/@ws/lib", "lib"]],
])(
  "a workspace link that appears after a failed lookup from %s loads on the next read",
  async (_, missing, present) => {
    await using dir = await fixture({
      ...workspace,
      // A subpath export into a subdirectory, as the package exports a face.
      "plugin/tui.ts": 'export { value, other } from "@ws/lib/tui/face"',
      "lib/package.json": JSON.stringify({ name: "@ws/lib", type: "module", exports: { "./tui/*": "./tui/*.ts" } }),
      "lib/tui/face.ts": 'export { value } from "../value"; export { other } from "@ws/other"',
      "other/package.json": JSON.stringify({ name: "@ws/other", type: "module", exports: { ".": "./index.ts" } }),
      "other/index.ts": 'export const other = "linked"',
    })
    const [link, target] = missing
    await dir.link(present[0], present[1])
    // The scope directory survives a reinstall; only the link inside it is gone.
    await mkdir(dir.path(path.dirname(link)), { recursive: true })
    await expect(dir.sources.read(dir.url("plugin/tui.ts"))).rejects.toThrow(
      `Cannot find package '@ws/${path.basename(link)}'`,
    )
    expect(dir.watched).toContain(dir.path(link))
    await dir.link(link, target)
    expect((await dir.sources.read(dir.url("plugin/tui.ts"))).module).toMatchObject({
      value: "before",
      other: "linked",
    })
  },
)

test("Node reloads a linked workspace package and keeps installed packages external", async () => {
  await using dir = await fixture({
    ...workspace,
    "plugin/tui.mjs": 'export { value } from "@ws/lib"; export { default as dep } from "dep"',
    "lib/package.json": JSON.stringify({ name: "@ws/lib", type: "module", exports: { ".": "./index.mjs" } }),
    "lib/index.mjs": 'export { value } from "./value.mjs"',
    "lib/value.mjs": 'export const value = "before"',
  })
  await dir.link("plugin/node_modules/@ws/lib", "lib")
  await dir.write(
    "probe.ts",
    `import assert from "node:assert/strict"
    import { writeFile } from "node:fs/promises"
    import { createPluginSources } from ${JSON.stringify(path.join(import.meta.dir, "../src/source.ts"))}
    const watched = []
    const sources = createPluginSources(async (file) => { watched.push(file) })
    const entry = ${JSON.stringify(dir.url("plugin/tui.mjs"))}
    try {
      const dep = await import(${JSON.stringify(dir.url("plugin/node_modules/dep/index.js"))})
      const before = (await sources.read(entry)).module
      assert.equal(before.value, "before")
      await writeFile(${JSON.stringify(dir.path("lib/value.mjs"))}, 'export const value = "after"')
      const after = (await sources.read(entry)).module
      assert.equal(after.value, "after")
      assert.equal(after.dep, dep.default)
      assert.ok(watched.includes(${JSON.stringify(dir.path("lib/value.mjs"))}))
      assert.ok(!watched.some((file) => file.includes("node_modules")))
      console.log("node workspace reload passed")
    } finally { sources.dispose() }`,
  )
  const build = await Bun.build({
    entrypoints: [dir.path("probe.ts")],
    target: "node",
    format: "esm",
    outdir: dir.path(""),
    naming: "probe.mjs",
  })
  expect(build.success).toBe(true)
  const child = Bun.spawn(["node", "--no-warnings", dir.path("probe.mjs")], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ stdout, stderr, exit }).toEqual({ stdout: "node workspace reload passed\n", stderr: "", exit: 0 })
})

async function fixture(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-source-")))
  const resolve = (file: string) => path.join(root, file)
  const write = async (file: string, content: string) => {
    await mkdir(path.dirname(resolve(file)), { recursive: true })
    await writeFile(resolve(file), content)
  }
  await Promise.all(Object.entries(files).map(([file, content]) => write(file, content)))
  const watched: string[] = []
  const sources = createPluginSources(async (file) => {
    watched.push(file)
  })
  return {
    sources,
    watched,
    write,
    path: resolve,
    url: (file: string) => pathToFileURL(resolve(file)).href,
    link: async (link: string, target: string) => {
      await mkdir(path.dirname(resolve(link)), { recursive: true })
      await symlink(path.relative(path.dirname(resolve(link)), resolve(target)), resolve(link), "dir")
    },
    [Symbol.asyncDispose]: async () => {
      sources.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
