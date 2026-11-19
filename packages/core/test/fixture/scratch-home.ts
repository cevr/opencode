import fs from "fs"
import os from "os"
import path from "path"
import { afterAll } from "bun:test"

/**
 * Points opencode's global roots (Global.home and the XDG data, config, cache and state roots) at a
 * scratch directory, so no test reads or writes the developer's real ones: a fresh database file
 * would otherwise import their auth.json, and config would load from their ~/.config/opencode.
 * Call it from a test preload, before any module computes its paths (`@opencode/util/global` reads
 * them once, at import).
 *
 * HOME stays as it is: Bun's os.homedir() keeps the value the process started with, so changing HOME
 * here would split in-process paths from child processes. A runner that sets HOME before it starts
 * Bun (packages/core's script/test.ts) also sets OPENCODE_TEST_HOME, and then this does nothing.
 */
export function useScratchHome() {
  if (process.env.OPENCODE_TEST_HOME) return
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-home-")))
  // Bun runs no exit handlers after a test run; a preload's afterAll runs once all of its tests end.
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }))
  Object.assign(process.env, {
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
  })
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_CONTENT
  spawnWithCurrentEnvironment()
}

/**
 * Bun.spawn and Bun.spawnSync called without `env` pass the environment the process started with, not
 * process.env (measured on Bun 1.4.4; node:child_process and Bun.$ pass process.env), so their children would
 * still resolve the developer's real roots: cli tests wrote the real opencode-local.log that way. Default
 * their `env` to the current process.env, as Bun documents.
 */
function spawnWithCurrentEnvironment() {
  type Options = { env?: Record<string, string | undefined> }
  const withEnvironment = (options: unknown) => {
    const given = (options ?? {}) as Options
    return given.env ? given : { ...given, env: process.env }
  }
  type Spawn = (...args: unknown[]) => unknown
  const wrap = (original: Spawn): Spawn =>
    function (this: unknown, ...args) {
      const [first, second, ...rest] = args
      const call = Array.isArray(first)
        ? [first, withEnvironment(second), ...rest]
        : [withEnvironment(first), ...args.slice(1)]
      return original.apply(this, call)
    }
  Bun.spawn = wrap(Bun.spawn as Spawn) as typeof Bun.spawn
  Bun.spawnSync = wrap(Bun.spawnSync as Spawn) as typeof Bun.spawnSync
}

/**
 * The global roots, out of `Global.Path` (pass it in: importing Global here would compute its roots before
 * useScratchHome runs), that lie outside the scratch home. Empty when the package's preload ran useScratchHome;
 * every root when it did not, so each package's guard test turns red if its preload loses the call.
 */
export function rootsOutsideScratchHome(paths: Record<"data" | "config" | "cache" | "state" | "log", string>) {
  const home = process.env.OPENCODE_TEST_HOME
  const roots = {
    data: paths.data,
    config: paths.config,
    cache: paths.cache,
    state: paths.state,
    log: paths.log,
    configDirectory: process.env.OPENCODE_CONFIG_DIR ?? paths.config,
  }
  const inside = (root: string) => {
    if (!home) return false
    const relative = path.relative(home, root)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  }
  return Object.entries(roots)
    .filter(([, root]) => !inside(root))
    .map(([name]) => name)
}
