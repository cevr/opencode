// Whether a process runs OpenCode from source, with a JavaScript runtime (`bun`, `node`) as its executable, rather
// than as a compiled build. A build is a fixed copy: it binds the plugin tree installed beside its own executable (the
// CLI's adjacent config) and loads its plugins once, with no watch on their source. A run from source (a dev launcher,
// a scratch harness, the tests) is never bound and hot-reloads its local plugins.
import path from "node:path"

const RUNTIMES = new Set(["bun", "node", "nodejs"])

/** Whether the executable at `execPath` is a JavaScript runtime running OpenCode from source. */
export const fromSource = (execPath: string = process.execPath) =>
  RUNTIMES.has(path.basename(execPath, path.extname(execPath)).toLowerCase())

export * as SourceRun from "./source-run.js"
