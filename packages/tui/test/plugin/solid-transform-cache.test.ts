import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { cachedSolidLoad } from "../../src/plugin/solid-transform-cache"

test("a plugin source compiles once per content, and again once it changes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "solid-transform-cache-"))
  const source = path.join(dir, "view.tsx")
  const compiled: string[] = []
  const load = cachedSolidLoad(async (args) => {
    compiled.push(args.path)
    return { contents: `compiled(${await Bun.file(args.path).text()})`, loader: "js" }
  }, path.join(dir, "cache"))

  writeFileSync(source, "one")
  expect(await load({ path: source })).toEqual({ contents: "compiled(one)", loader: "js" })
  expect(await load({ path: `${source}?query` })).toEqual({ contents: "compiled(one)", loader: "js" })
  expect(compiled).toEqual([source])

  writeFileSync(source, "two")
  expect(await load({ path: source })).toEqual({ contents: "compiled(two)", loader: "js" })
  expect(compiled).toEqual([source, source])

  // Another start reads the entries back without compiling.
  const again = cachedSolidLoad(async () => {
    throw new Error("compiled again")
  }, path.join(dir, "cache"))
  expect(await again({ path: source })).toEqual({ contents: "compiled(two)", loader: "js" })
})
