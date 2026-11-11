// OpenTUI compiles every external TUI plugin source (`.ts` and `.tsx`) through Babel's Solid preset on each
// start: a second or more for a few hundred files on a busy machine, before any session can draw. The
// output depends only on the source and on the build (its Babel, presets and runtime module ids), so a
// release build keeps it on disk by content and reads it back on the next start. Builds without a version
// (from source, tests) transform as before. Install before `ensureRuntimePluginSupport`: OpenTUI then
// sees its Solid transform as installed and only hands it the runtime options it reads at load time.
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

declare const OPENCODE_VERSION: string

type Load = (args: { path: string }) => Promise<{ contents: string; loader: string } | undefined>

const solidTransformState = Symbol.for("opentui.solid.transform")

/** Wraps a Solid transform loader so the same source under the same build is compiled once. */
export function cachedSolidLoad(load: Load, dir: string): Load {
  return async (args) => {
    const file = args.path.replace(/[?#].*$/, "")
    let code: string
    try {
      code = readFileSync(file, "utf8")
    } catch {
      return load(args)
    }
    const key = createHash("sha256").update(file).update("\0").update(code).digest("hex")
    const entry = path.join(dir, `${key}.js`)
    try {
      return { contents: readFileSync(entry, "utf8"), loader: "js" }
    } catch {}
    const result = await load(args)
    if (result?.loader !== "js") return result
    try {
      mkdirSync(dir, { recursive: true })
      // Written aside and renamed, so a TUI starting at the same moment never reads half an entry.
      const staged = `${entry}.${process.pid}`
      writeFileSync(staged, result.contents)
      renameSync(staged, entry)
    } catch {}
    return result
  }
}

/** Installs OpenTUI's Solid transform with a disk cache under `root`, one directory per build version. */
export function installCachedSolidTransform(root: string, version: string) {
  const state = ((globalThis as Record<symbol, { installed?: boolean } | undefined>)[solidTransformState] ??= {
    installed: false,
  })
  if (state.installed) return false
  const dir = path.join(root, version.replace(/[^a-zA-Z0-9._-]/g, "-"))
  // Entries of other builds are never read again.
  try {
    for (const name of readdirSync(root)) if (path.join(root, name) !== dir) rmSync(path.join(root, name), { recursive: true, force: true })
  } catch {}
  const inner = createSolidTransformPlugin()
  Bun.plugin({
    name: "opencode-solid-transform-cache",
    setup(build) {
      // OpenTUI's transform only registers loaders.
      inner.setup({
        onLoad: (options: Parameters<typeof build.onLoad>[0], load: Load) =>
          build.onLoad(options, cachedSolidLoad(load, dir) as Parameters<typeof build.onLoad>[1]),
      } as unknown as typeof build)
    },
  })
  state.installed = true
  return true
}

export function buildVersion() {
  return typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : undefined
}
