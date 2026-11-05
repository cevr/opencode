import { registerHooks } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { localSource } from "./source.js"
import { linkedPackageSource, missingPackageTarget, workspaceRoot } from "./source.package.js"
import { Host } from "./host.js"

let generation = Date.now()

export async function prepareSource(entrypoint: string, track: (file: string, directory?: boolean) => void) {
  const version = String(++generation)
  const workspace = workspaceRoot(fileURLToPath(entrypoint))
  const fresh = (specifier: string) => {
    const url = new URL(specifier)
    url.searchParams.set("__opencode_reload", version)
    return url.href
  }
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.parentURL || new URL(context.parentURL).searchParams.get("__opencode_reload") !== version)
        return nextResolve(specifier, context)
      const local =
        specifier.startsWith("./") || specifier.startsWith("../")
          ? new URL(specifier, context.parentURL)
          : localSource(specifier, path.dirname(fileURLToPath(context.parentURL)))
      // A file reached through node_modules is a package. It joins this
      // generation only when it is a package of the plugin's own workspace
      // (see linkedPackageSource); installed packages keep one instance.
      const linked = (resolved: ReturnType<typeof nextResolve>) => {
        if (!resolved.url.startsWith("file:")) return resolved
        const source = linkedPackageSource(fileURLToPath(resolved.url), workspace)
        if (!source) return resolved
        track(source)
        return { ...resolved, url: fresh(resolved.url) }
      }
      if (!local) {
        try {
          return linked(nextResolve(specifier, context))
        } catch (error) {
          const target = missingPackageTarget(specifier, fileURLToPath(context.parentURL))
          if (target) track(target, true)
          throw error
        }
      }
      if (fileURLToPath(local).split(path.sep).includes("node_modules")) return linked(nextResolve(specifier, context))
      const resolved = (() => {
        try {
          return nextResolve(specifier, context)
        } catch (error) {
          track(path.dirname(fileURLToPath(local)), true)
          throw error
        }
      })()
      if (!resolved.url.startsWith("file:")) return resolved
      const file = fileURLToPath(resolved.url)
      if (file.split(path.sep).includes("node_modules")) return resolved
      track(file)
      return { ...resolved, url: fresh(resolved.url) }
    },
  })
  const specifier = fresh(entrypoint)
  return { version: specifier, load: () => Host.load(specifier), dispose: () => hook.deregister() }
}
