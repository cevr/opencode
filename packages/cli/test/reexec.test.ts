import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function run(scenario: "move" | "stay" | "lost", handoff?: string) {
  const proc = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "fixture/reexec.ts"),
      import.meta.path,
      scenario,
      ...(handoff ? [handoff] : []),
    ],
    { cwd: path.join(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { pid: proc.pid, lines: stdout.trim().split("\n"), stderr, code }
}

test("replaces the process in place: same process id, the plan's environment, no descriptor but the terminal's", async () => {
  const { pid, lines, code } = await run("move")
  expect(lines.find((line) => line.startsWith("BEFORE "))?.split(" ")[1]).toBe(String(pid))
  expect(lines).toContain(`AFTER ${pid} carried`)
  expect(lines).toContain("FD closed")
  // execve does not return: the fixture's line after it never prints.
  expect(lines.some((line) => line.startsWith("RETURNED"))).toBe(false)
  expect(code).toBe(0)
})

test("a build that cannot run leaves the process on its own build, in place, told not to retry", async () => {
  const { pid, lines, stderr, code } = await run("stay")
  expect(stderr).toContain("could not move onto /nonexistent/loop-probe-x")
  expect(lines).toContain(`STAYED ${pid} stayed`)
  expect(lines).toContain("FD closed")
  expect(lines.some((line) => line.startsWith("RETURNED"))).toBe(false)
  expect(code).toBe(0)
})

test("when no build runs, the handoff holding the drafts is deleted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reexec-"))
  try {
    const handoff = path.join(dir, "handoff.json")
    const { lines } = await run("lost", handoff)
    expect(lines).toContain("RETURNED 1")
    expect(existsSync(handoff)).toBe(false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
