import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Host } from "./host.js"
import { provides } from "./runtime.js"
import { localSource } from "./source.js"
import { linkedPackageSource, missingPackageTarget, workspaceRoot } from "./source.package.js"

let generation = Date.now()
// Every file a plugin graph has visited in this process. A linked package file
// already in the native cache but absent here was loaded by the host itself
// (OpenCode running from a checkout that the plugin also links), so the plugin
// shares that instance instead of invalidating the host's module.
const visited = new Set<string>()

export async function prepareSource(entrypoint: string, track: (file: string, directory?: boolean) => void) {
  const root = fileURLToPath(entrypoint)
  const workspace = workspaceRoot(root)
  const files = new Set<string>()
  const visit = (file: string, search = "") => {
    if (file !== root && file.split(path.sep).includes("node_modules")) return
    if (search) delete require.cache[file + search]
    if (files.has(file)) return
    files.add(file)
    visited.add(file)
    // Bun exposes ESM here too. Delete known keys even when absent: rejected
    // evaluations are not enumerable, but deletion still invalidates them.
    delete require.cache[file]
    track(file)
    if (!/\.[cm]?[jt]sx?$/.test(file)) return
    // Scan dependencies only; the normal runtime loader still owns compilation,
    // package resolution, import attributes, and error reporting.
    const imports = (() => {
      try {
        return new Bun.Transpiler({
          loader: file.endsWith("tsx") ? "tsx" : file.endsWith("jsx") ? "jsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js",
          target: "bun",
        }).scan(readFileSync(file, "utf8")).imports
      } catch {
        return []
      }
    })()
    // A file reached through node_modules is a package. It joins the plugin's
    // source graph only when it is a package of the plugin's own workspace
    // (see linkedPackageSource). Resolving the link erases the node_modules
    // boundary, so a relative path is classified by the path it requested.
    const visitPackage = (resolved: string) => {
      const source = linkedPackageSource(resolved, workspace)
      if (!source || (Object.hasOwn(require.cache, source) && !visited.has(source))) return
      // Bun keys a module by the path it resolved, normally the real one; drop
      // the spelling through the link too so neither serves the old module.
      if (resolved !== source) delete require.cache[resolved]
      visit(source)
    }
    for (const item of imports) {
      const local =
        item.path.startsWith("./") || item.path.startsWith("../")
          ? new URL(item.path, pathToFileURL(file))
          : localSource(item.path, path.dirname(file))
      const resolve = (specifier: string) =>
        item.kind === "require-call"
          ? createRequire(file).resolve(specifier)
          : Bun.resolveSync(specifier, path.dirname(file))
      if (!local) {
        if (provides(item.path)) continue
        const resolved = (() => {
          try {
            return resolve(item.path)
          } catch {
            // The package may have been linked since Bun last listed these
            // directories; forget those listings and ask once more.
            forgetPackageLookup(item.path, file)
            try {
              return resolve(item.path)
            } catch {
              return undefined
            }
          }
        })()
        if (resolved === undefined) {
          const target = missingPackageTarget(item.path, file)
          if (target) track(target, true)
          continue
        }
        visitPackage(resolved)
        continue
      }
      const requested = fileURLToPath(local)
      try {
        const resolved = resolve(requested)
        if (requested.split(path.sep).includes("node_modules")) visitPackage(resolved)
        else visit(resolved, local.search)
      } catch {
        // A missing local dependency may appear on the next save. Leave its
        // actual failure (or optional fallback) to the native loader.
        track(path.dirname(requested), true)
      }
    }
  }
  visit(root)
  return { version: String(++generation), load: () => Host.load(entrypoint) }
}

// Bun's resolver caches each directory listing for the process lifetime,
// including the ones a failed package lookup read, so a package linked after a
// failed import stays "Cannot find package" until the process restarts (measured
// on Bun 1.4.4). Its only reachable invalidation: when an absolute specifier is
// not found, Bun drops the cached listing of the specifier's directory before it
// retries (the not-found retry of `VirtualMachine::resolve` in
// src/jsc/VirtualMachine.rs). Ask for a file that does not exist in every
// directory a bare lookup of this specifier reads: each ancestor, its
// node_modules, and each directory along the specifier below it (a failed
// lookup also lists `node_modules/@scope/name/subdir` for `@scope/name/subdir/x`).
const probe = ".opencode-resolve-probe"
function forgetPackageLookup(specifier: string, importer: string) {
  if (specifier.startsWith("#") || /^[a-z]+:/i.test(specifier)) return
  const segments = specifier.split("/")
  for (let directory = path.dirname(importer); ; directory = path.dirname(directory)) {
    const modules = path.join(directory, "node_modules")
    const below = segments.map((_, index) => path.join(modules, ...segments.slice(0, index + 1)))
    for (const target of [directory, modules, ...below]) {
      try {
        Bun.resolveSync(path.join(target, probe), directory)
      } catch {}
    }
    if (path.dirname(directory) === directory) return
  }
}
