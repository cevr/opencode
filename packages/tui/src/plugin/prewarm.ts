import { Host } from "@opencode/plugin/host"
import { fileURLToPath } from "node:url"
import "#runtime-plugin-support"
import { localSource } from "./discovery"
import { createPluginSources } from "./source"

type Entry = string | { readonly package: string }

/**
 * Starts importing the configured local TUI plugins while the TUI still reads its config and location
 * and creates its renderer. Imports are kept per entrypoint for the whole process (`createPluginSources`),
 * so the plugin provider's first reconciliation finds each graph read and evaluated already, and only
 * checks that its files did not change since. Packages, disabled entries and paths that are not
 * directories are left to the reconciliation, as is every failure.
 */
export function prewarmPlugins(entries: ReadonlyArray<Entry>, directory: string) {
  const sources = createPluginSources(async () => {})
  for (const entry of entries) {
    const target = typeof entry === "string" ? entry : entry.package
    if (target.startsWith("-")) continue
    const local = localSource(target, directory)
    if (!local) continue
    void Promise.resolve()
      .then(() => {
        const entrypoint = Host.resolve({ directory: fileURLToPath(local) }).tui
        return entrypoint ? sources.read(entrypoint) : undefined
      })
      .catch(() => undefined)
  }
}
