import { expect, test } from "bun:test"
import path from "node:path"

test("replaces the process in place: same process id, the plan's environment, no descriptor but the terminal's", async () => {
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/reexec.ts"), import.meta.path], {
    cwd: path.join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000)
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  clearTimeout(timer)
  const lines = stdout.trim().split("\n")
  const before = lines.find((line) => line.startsWith("BEFORE "))?.split(" ")
  expect(before?.[1]).toBe(String(proc.pid))
  expect(lines).toContain(`AFTER ${proc.pid} carried`)
  expect(lines).toContain("FD closed")
  // execve does not return: the fixture's line after it never prints.
  expect(lines.some((line) => line.startsWith("RETURNED"))).toBe(false)
  expect(code).toBe(0)
})
