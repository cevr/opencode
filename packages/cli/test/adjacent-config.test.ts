import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bind, cliConfigContent, configFile, directoryOf, KEYS } from "../src/adjacent-config"

// Real path: a compiled build reports its executable resolved (macOS's /var is /private/var).
const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-adjacent-")))
afterAll(() => fs.rm(dir, { recursive: true, force: true }))

/** A build at `<dir>/<name>/opencode-<name>`, with a tree beside it holding `name`'s two overlay files when `tree`. */
async function build(name: string, tree: boolean) {
  const executable = path.join(dir, name, `opencode-${name}`)
  await fs.mkdir(path.dirname(executable), { recursive: true })
  if (tree) {
    const config = directoryOf(executable)
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(path.join(config, "opencode.json"), JSON.stringify({ plugin: [`/${name}/server`] }))
    await fs.writeFile(path.join(config, "cli.json"), JSON.stringify({ plugins: [`/${name}/tui`] }))
  }
  return executable
}

/** The environment an older bound build (one that kept its binding in its environment) gives its children. */
const inherited = () => ({
  OPENCODE_CONFIG: "/nonexistent/loop-probe-x/old.plugins/config/opencode.json",
  OPENCODE_CLI_CONFIG_CONTENT: '{"plugins":["/nonexistent/loop-probe-x/old"]}',
  OPENCODE_ADJACENT_CONFIG: "/nonexistent/loop-probe-x/old.plugins/config",
  OTHER: "kept",
})

const own = { OPENCODE_CONFIG: "/nonexistent/loop-probe-x/mine.json", OPENCODE_CLI_CONFIG_CONTENT: "{}", OTHER: "kept" }

const loadsOf = (executable: string, name: string) => ({
  config: path.join(directoryOf(executable), "opencode.json"),
  cli: JSON.stringify({ plugins: [`/${name}/tui`] }),
})

/** What the process loads with `env` after binding as `executable`, and the environment its children inherit. */
function bound(executable: string, env: Record<string, string | undefined>) {
  const binding = bind(executable, env)
  return { loads: { config: configFile(binding, env), cli: cliConfigContent(binding, env) }, env }
}

describe("bind", () => {
  test("a tree beside the executable is loaded over inherited values and stays out of the environment", async () => {
    const executable = await build("beside", true)
    expect(bound(executable, inherited())).toEqual({ loads: loadsOf(executable, "beside"), env: { OTHER: "kept" } })
  })

  test("a tree beside the executable wins over a user's own keys, which stay for its children", async () => {
    const executable = await build("beside-own", true)
    expect(bound(executable, { ...own })).toEqual({ loads: loadsOf(executable, "beside-own"), env: own })
  })

  test("a tree with no cli.json leaves the TUI its own cli.json", async () => {
    const executable = await build("server-only", true)
    await fs.rm(path.join(directoryOf(executable), "cli.json"))
    expect(bound(executable, { ...own }).loads).toEqual({
      config: path.join(directoryOf(executable), "opencode.json"),
      cli: undefined,
    })
  })

  test("no tree and no marker loads and keeps a user's own keys", async () => {
    const executable = await build("plain", false)
    expect(bound(executable, { ...own })).toEqual({
      loads: { config: own.OPENCODE_CONFIG, cli: own.OPENCODE_CLI_CONFIG_CONTENT },
      env: own,
    })
  })

  test("no tree with an inherited marker drops all three keys", async () => {
    const executable = await build("old", false)
    expect(bound(executable, inherited())).toEqual({
      loads: { config: undefined, cli: undefined },
      env: { OTHER: "kept" },
    })
  })

  test("a run from source, with bun or node as the executable, is never bound and drops an inherited binding", async () => {
    // Even with a tree beside the runtime's own path: a source run started from an older installed build's shell
    // loads its own plugins, not the installed build's.
    for (const runtime of ["bun", "node", "bun.exe"]) {
      const executable = path.join(dir, "source", runtime)
      await fs.mkdir(directoryOf(executable), { recursive: true })
      expect(bound(executable, inherited())).toEqual({
        loads: { config: undefined, cli: undefined },
        env: { OTHER: "kept" },
      })
    }
  })

  test("a run from source loads and keeps a user's own keys (no marker)", () => {
    expect(bound(path.join(dir, "source", "bun"), { ...own })).toEqual({
      loads: { config: own.OPENCODE_CONFIG, cli: own.OPENCODE_CLI_CONFIG_CONTENT },
      env: own,
    })
  })
})

describe("a compiled build moving onto another", () => {
  let stub = ""
  beforeAll(async () => {
    stub = path.join(dir, "stub")
    const compile = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        path.join(import.meta.dir, "fixture/adjacent-config.ts"),
        "--outfile",
        stub,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stderr, code] = await Promise.all([new Response(compile.stderr).text(), compile.exited])
    if (code !== 0) throw new Error(`compile failed: ${stderr}`)
  }, 60_000)

  /** Copies the compiled stub to each path and runs the chain `first → ...rest` from `start`, one report per build. */
  async function chain(executables: ReadonlyArray<string>, start: Record<string, string> = {}) {
    for (const executable of executables) await fs.copyFile(stub, executable)
    const env: Record<string, string | undefined> = { ...process.env }
    for (const key of KEYS) delete env[key]
    // Outside the package, whose bunfig a compiled build would read.
    const proc = Bun.spawn([...executables], {
      cwd: dir,
      env: { ...env, ...start },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    const timer = setTimeout(() => process.kill(-proc.pid, "SIGKILL"), 20_000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    expect(stderr).toBe("")
    expect(code).toBe(0)
    return stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  test("build N loads its tree with none of it in its environment, and N+1 loads its own", async () => {
    const n = await build("n", true)
    const next = await build("next", true)
    const [first, second] = await chain([n, next])
    expect(first).toEqual({ build: n, loads: loadsOf(n, "n"), env: {} })
    expect(second).toEqual({ build: next, loads: loadsOf(next, "next"), env: {} })
  }, 30_000)

  test("started from an older bound build's shell, a build drops that binding and loads its own", async () => {
    const n = await build("n3", true)
    const [first] = await chain([n], { ...inherited(), OTHER: "kept" })
    expect(first).toEqual({ build: n, loads: loadsOf(n, "n3"), env: {} })
  }, 30_000)

  test("a bound build moving back onto a build with no tree leaves it nothing bound", async () => {
    const n = await build("n2", true)
    const old = await build("old2", false)
    const [first, second] = await chain([n, old])
    expect(first).toEqual({ build: n, loads: loadsOf(n, "n2"), env: {} })
    expect(second).toEqual({ build: old, loads: { config: undefined, cli: undefined }, env: {} })
  }, 30_000)
})
