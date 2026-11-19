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
}
