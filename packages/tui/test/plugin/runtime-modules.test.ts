import { expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createMemo, createRoot } from "solid-js"
import "../../src/plugin/runtime-plugin-support.bun"
import { tmpdir } from "../fixture/fixture"

// A plugin split into workspace packages reaches its own modules through package links in node_modules, as
// bun and npm workspaces link them. Bun runs a runtime plugin's onResolve for a relative import but not for a
// bare one, so OpenTUI's rewrite never saw such a module, and its `solid-js` import loaded whatever copy sat on
// disk: a second Solid, whose getOwner() is null inside the host's computations.
test("a plugin's .ts module reached through a package link reads the host's Solid, not a copy on disk", async () => {
  await using temporary = await tmpdir()
  const root = temporary.path
  await Bun.write(
    path.join(root, "lib/package.json"),
    JSON.stringify({ name: "@fixture/lib", type: "module", exports: { "./*": "./*.ts" } }),
  )
  await Bun.write(
    path.join(root, "lib/owner.ts"),
    `import { getOwner } from "solid-js"\nexport const owned = () => getOwner() !== null\n`,
  )
  // The copy on disk the package would resolve on its own: never the host's.
  await Bun.write(
    path.join(root, "node_modules/solid-js/package.json"),
    JSON.stringify({ name: "solid-js", type: "module", exports: { ".": "./index.js" } }),
  )
  await Bun.write(path.join(root, "node_modules/solid-js/index.js"), `export const getOwner = () => null\n`)
  await mkdir(path.join(root, "plugin/node_modules/@fixture"), { recursive: true })
  await symlink(path.join(root, "lib"), path.join(root, "plugin/node_modules/@fixture/lib"))
  await Bun.write(path.join(root, "plugin/tui.tsx"), `export { owned } from "@fixture/lib/owner"\n`)

  const plugin = await import(pathToFileURL(path.join(root, "plugin/tui.tsx")).href)
  expect(createRoot(() => createMemo(() => plugin.owned()))()).toBe(true)
})
