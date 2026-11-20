import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bind, directoryOf, KEYS } from "../src/adjacent-config"

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

const inherited = () => ({
  OPENCODE_CONFIG: "/nonexistent/loop-probe-x/old.plugins/config/opencode.json",
  OPENCODE_CLI_CONFIG_CONTENT: '{"plugins":["/nonexistent/loop-probe-x/old"]}',
  OPENCODE_ADJACENT_CONFIG: "/nonexistent/loop-probe-x/old.plugins/config",
  OTHER: "kept",
})

const boundTo = (executable: string, name: string) => ({
  OPENCODE_CONFIG: path.join(directoryOf(executable), "opencode.json"),
  OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [`/${name}/tui`] }),
  OPENCODE_ADJACENT_CONFIG: directoryOf(executable),
})

describe("bind", () => {
  test("a tree beside the executable sets the three keys from it, over inherited values", async () => {
    const executable = await build("beside", true)
    const env: Record<string, string | undefined> = inherited()
    bind(executable, env)
    expect(env).toEqual({ ...boundTo(executable, "beside"), OTHER: "kept" })
  })

  test("no tree and no marker leaves the environment as it is, a user's own OPENCODE_CONFIG with it", async () => {
    const executable = await build("plain", false)
    const env: Record<string, string | undefined> = {
      OPENCODE_CONFIG: "/nonexistent/loop-probe-x/mine.json",
      OPENCODE_CLI_CONFIG_CONTENT: "{}",
      OTHER: "kept",
    }
    bind(executable, env)
    expect(env).toEqual({
      OPENCODE_CONFIG: "/nonexistent/loop-probe-x/mine.json",
      OPENCODE_CLI_CONFIG_CONTENT: "{}",
      OTHER: "kept",
    })
  })

  test("no tree with an inherited marker unsets all three keys", async () => {
    const executable = await build("old", false)
    const env: Record<string, string | undefined> = inherited()
    bind(executable, env)
    expect(env).toEqual({ OTHER: "kept" })
  })

  test("a run from source, with bun or node as the executable, is never bound", async () => {
    // Even with a tree beside the runtime's own path.
    for (const runtime of ["bun", "node", "bun.exe"]) {
      const executable = path.join(dir, "source", runtime)
      await fs.mkdir(directoryOf(executable), { recursive: true })
      const env: Record<string, string | undefined> = inherited()
      bind(executable, env)
      expect(env).toEqual(inherited())
    }
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

  /** Copies the compiled stub to `name`'s path and runs the chain `first → ...rest`, one report per build. */
  async function chain(executables: ReadonlyArray<string>) {
    for (const executable of executables) await fs.copyFile(stub, executable)
    const env = { ...process.env }
    for (const key of KEYS) delete env[key]
    // Outside the package, whose bunfig a compiled build would read.
    const proc = Bun.spawn([...executables], {
      cwd: dir,
      env,
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
      .map((line) => JSON.parse(line) as Record<string, string>)
  }

  test("build N execs build N+1 carrying N's keys, and N+1 ends with its own", async () => {
    const n = await build("n", true)
    const next = await build("next", true)
    const [first, second] = await chain([n, next])
    expect(first).toEqual({ build: n, ...boundTo(n, "n") })
    expect(second).toEqual({ build: next, ...boundTo(next, "next") })
  }, 30_000)

  test("a bound build moving back onto a build with no tree leaves it none of the bound keys", async () => {
    const n = await build("n2", true)
    const old = await build("old2", false)
    const [first, second] = await chain([n, old])
    expect(first).toEqual({ build: n, ...boundTo(n, "n2") })
    expect(second).toEqual({ build: old })
  }, 30_000)
})
