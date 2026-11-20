// Binds a compiled build to the plugin configuration installed beside its own executable, before anything reads config.
//
// An installer may place `<executable>.plugins/config/` next to a build: `opencode.json`, loaded as one more config
// document after the global ones (in place of `OPENCODE_CONFIG`), and `cli.json`, whose text the TUI reads in place of
// its own (in place of `OPENCODE_CLI_CONFIG_CONTENT`). The binding derives from the executable's path alone and lives
// in this module, never in the process's environment: every child (an agent's command, a terminal, an MCP server, a
// run from source, another binary that reads `OPENCODE_CONFIG`) starts unbound, and a child that is itself a build
// binds again from its own executable. Builds before this one put the binding in their environment, marked by
// `OPENCODE_ADJACENT_CONFIG`; such an inherited binding is dropped here, in a compiled build and a run from source
// alike, and a user's own `OPENCODE_CONFIG` (no marker) stays. A run from source (`bun` or `node` as the executable) is
// never bound. Imported first by the CLI for its side effect; it imports nothing else of OpenCode but the pure
// `SourceRun` rule, so no module reads the environment before it.
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { SourceRun } from "@opencode/util/source-run"

/** The keys an older bound build left in its environment, all or none; `OPENCODE_ADJACENT_CONFIG` marks them. */
export const KEYS = ["OPENCODE_CONFIG", "OPENCODE_CLI_CONFIG_CONTENT", "OPENCODE_ADJACENT_CONFIG"] as const

/** Where a build's adjacent config lives: `<executable>.plugins/config`. */
export const directoryOf = (execPath: string) => path.join(`${execPath}.plugins`, "config")

/** A build's own binding: the tree's `opencode.json`, and the text of its `cli.json` when there is one. */
export type Binding = { readonly config: string; readonly cli: string | undefined }

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

/** Drops an inherited binding from `env` and returns the executable at `execPath`'s own, if it has one. */
export function bind(execPath: string, env: Record<string, string | undefined>): Binding | undefined {
  if (env.OPENCODE_ADJACENT_CONFIG !== undefined) for (const key of KEYS) delete env[key]
  if (SourceRun.fromSource(execPath)) return undefined
  const dir = directoryOf(execPath)
  if (!isDirectory(dir)) return undefined
  return { config: path.join(dir, "opencode.json"), cli: textOf(path.join(dir, "cli.json")) }
}

/** This process's binding. */
export const binding = bind(process.execPath, process.env)

/** The config document to load after the global ones: the binding's, else the user's `OPENCODE_CONFIG`. */
export const configFile = (own = binding, env: Record<string, string | undefined> = process.env) =>
  own === undefined ? env.OPENCODE_CONFIG : own.config

/** The text the TUI reads in place of its `cli.json`: the binding's, else the user's `OPENCODE_CLI_CONFIG_CONTENT`. */
export const cliConfigContent = (own = binding, env: Record<string, string | undefined> = process.env) =>
  own === undefined ? env.OPENCODE_CLI_CONFIG_CONTENT : own.cli
