import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import { Hash } from "@opencode/util/hash"

// Import attempts by entrypoint, for the whole process. A server keeps one
// set of sources per location; an unchanged local graph is still evaluated
// once per process, as the native module cache does for an installed package.
const attempts = new Map<string, Source>()

// Keep source fingerprints and import attempts together. Filesystem events
// should reload changed local graphs, not repeat unchanged evaluations.
export function createPluginSources(watch: (file: string) => Promise<void>) {
  const cleanups: Array<() => void> = []
  const watching = new Set<Promise<void>>()
  const watched = new Set<string>()
  const subscribe = (file: string) => {
    watched.add(file)
    const pending = watch(file).finally(() => watching.delete(pending))
    watching.add(pending)
    // Watch setup can be interrupted while module evaluation is still pending.
    void pending.catch(() => {})
  }
  return {
    read: async (entrypoint: string) => {
      await Promise.all(watching)
      const previous = attempts.get(entrypoint)
      if (previous && [...previous.files].every(([file, item]) => item.digest === digest(file, item.directory))) {
        // Another set of sources may have loaded it: this one still hears an edit to its graph.
        for (const file of previous.files.keys()) if (!watched.has(file)) subscribe(file)
        await Promise.all(watching)
        return previous.loaded
      }

      const files: Source["files"] = new Map()
      const track = (file: string, directory = false) => {
        if (files.has(file)) return
        files.set(file, { digest: digest(file, directory), directory })
        subscribe(file)
      }
      track(fileURLToPath(entrypoint))
      const { prepareSource } = await import("#plugin-source")
      const prepared: { version: string; load: () => Promise<unknown>; dispose?: () => void } = await prepareSource(
        entrypoint,
        track,
      )
      if (prepared.dispose) cleanups.push(prepared.dispose)
      // Cache the attempt before evaluating it: unchanged failing modules must
      // not repeat import-time effects on every filesystem notification.
      const loaded = prepared.load().then((module) => ({ version: prepared.version, module }))
      attempts.set(entrypoint, { loaded, files })
      return loaded.finally(() => Promise.all(watching))
    },
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
}

type Source = {
  loaded: Promise<{ version: string; module: unknown }>
  files: Map<string, { digest: string; directory: boolean }>
}

function digest(file: string, directory: boolean) {
  try {
    return Hash.sha256(directory ? JSON.stringify(readdirSync(file).sort()) : readFileSync(file))
  } catch {
    return "missing"
  }
}

export function localSource(spec: string, directory: string) {
  if (spec.startsWith("file://")) return new URL(spec)
  if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec))
    return pathToFileURL(path.resolve(directory, spec))
  return undefined
}
