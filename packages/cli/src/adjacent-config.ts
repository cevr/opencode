// Binds a compiled build to the plugin configuration installed beside its own executable, before anything reads config.
//
// An installer may place `<executable>.plugins/config/` next to a build: `opencode.json`, loaded as one more config
// document after the global ones (`OPENCODE_CONFIG`), and `cli.json`, whose text the TUI reads in place of its own
// (`OPENCODE_CLI_CONFIG_CONTENT`). The binding derives from the executable's path alone, so it follows the build: a
// process that replaced another (a TUI's move, a service started by an older client) carries the other build's
// environment, and is bound again here to its own. A build with no such directory unsets the keys it inherited from a
// bound build (marked by `OPENCODE_ADJACENT_CONFIG`) and leaves a user's own `OPENCODE_CONFIG` alone. A run from
// source (`bun` or `node` as the executable) is never bound. Imported first by the CLI for its side effect; it imports
// nothing else of OpenCode, so no module reads the environment before it.
import { readFileSync, statSync } from "node:fs"
import path from "node:path"

/** The three keys the binding sets, all or none. */
export const KEYS = ["OPENCODE_CONFIG", "OPENCODE_CLI_CONFIG_CONTENT", "OPENCODE_ADJACENT_CONFIG"] as const

/** Where a build's adjacent config lives: `<executable>.plugins/config`. */
export const directoryOf = (execPath: string) => path.join(`${execPath}.plugins`, "config")

const RUNTIMES = new Set(["bun", "node", "nodejs"])

const isDirectory = (dir: string) => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

const textOf = (file: string) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** Applies the binding for the executable at `execPath` to `env`. */
export function bind(execPath: string, env: Record<string, string | undefined>) {
  if (RUNTIMES.has(path.basename(execPath, path.extname(execPath)).toLowerCase())) return
  const dir = directoryOf(execPath)
  if (!isDirectory(dir)) {
    if (env.OPENCODE_ADJACENT_CONFIG !== undefined) for (const key of KEYS) delete env[key]
    return
  }
  env.OPENCODE_CONFIG = path.join(dir, "opencode.json")
  const cli = textOf(path.join(dir, "cli.json"))
  if (cli === undefined) delete env.OPENCODE_CLI_CONFIG_CONTENT
  else env.OPENCODE_CLI_CONFIG_CONTENT = cli
  env.OPENCODE_ADJACENT_CONFIG = dir
}

bind(process.execPath, process.env)
