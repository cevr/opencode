import { afterAll, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reexec-"))
afterAll(() => fs.rm(dir, { recursive: true, force: true }))

async function run(scenario: "move" | "crash" | "missing" | "lost" | "again" | "direct") {
  const proc = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixture/reexec.ts"), import.meta.path, scenario, dir],
    { cwd: path.join(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  const lines = stdout.trim().split("\n")
  const left = readdirSync(dir).filter((name) => name.startsWith(`${proc.pid}`))
  return { pid: proc.pid, lines, stderr, code, left }
}

test("a move runs the new build under a watcher in this process's place, with the plan's environment and no descriptor but the terminal's", async () => {
  const { pid, lines, code, left } = await run("move")
  expect(lines[0]?.split(" ")[1]).toBe(String(pid))
  // The new build is the child of the watcher, which holds this process's id (and so its pane).
  const after = lines.find((line) => line.startsWith("AFTER "))?.split(" ")
  expect(after?.[2]).toBe(String(pid))
  expect(after?.[3]).toBe("carried")
  expect(lines).toContain("FD closed")
  expect(lines.some((line) => line.startsWith("RETURNED") || line.startsWith("STAYED"))).toBe(false)
  expect(code).toBe(0)
  expect(left).toEqual([])
})

for (const scenario of ["crash", "missing"] as const) {
  test(`a new build that ${scenario === "crash" ? "runs but dies before its screen is up" : "does not run"} leaves the pane on this build, with the drafts, told not to retry`, async () => {
    const { pid, lines, stderr, code } = await run(scenario)
    expect(stderr).toContain("did not start; staying on this build")
    // The watcher becomes this build again: the same process id, the handoff still there to read.
    expect(lines).toContain(`STAYED ${pid} new-build drafts`)
    expect(code).toBe(0)
  })
}

test("when no build runs, the handoff holding the drafts is deleted", async () => {
  const { lines, code, left } = await run("lost")
  expect(lines.some((line) => line.startsWith("STAYED"))).toBe(false)
  expect(code).not.toBe(0)
  expect(left).toEqual([])
})

test("a build that moves again does so through the same watcher: no watcher stacks on another", async () => {
  const { pid, lines, code, left } = await run("again")
  const second = lines.find((line) => line.startsWith("SECOND "))?.split(" ")
  // The second move's build is again the child of the first watcher's process.
  expect(second?.[2]).toBe(String(pid))
  expect(lines.some((line) => line.startsWith("STAYED"))).toBe(false)
  expect(code).toBe(0)
  expect(left).toEqual([])
})

test("without a handoff the build replaces the process directly", async () => {
  const { pid, lines, code } = await run("direct")
  expect(lines.find((line) => line.startsWith("DIRECT "))?.split(" ")[1]).toBe(String(pid))
  expect(lines.some((line) => line.startsWith("RETURNED"))).toBe(false)
  expect(code).toBe(0)
})
