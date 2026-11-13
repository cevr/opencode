import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// The file logger batches its lines for up to a second. A process stopped by a signal must not lose that batch when
// something kills it before its teardown ends: the standalone server is SIGKILLed 3 s after SIGTERM, and a loaded
// host's teardown outlasts that.
const posix = test.skipIf(process.platform === "win32")
const dir = mkdtempSync(path.join(os.tmpdir(), "shutdown-log-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

posix("a line logged before SIGTERM, and the shutdown's own line, are on disk when teardown is killed", async () => {
  const target = path.join(dir, "killed.log")
  const proc = spawn(target, 60_000, "hang")
  try {
    await readLine(proc.stdout, "SHUTDOWN_READY")
    proc.kill("SIGTERM")
    // Teardown has started and hangs; kill it as the standalone server's parent does once its grace is over.
    await readLine(proc.stdout, "SHUTDOWN_TEARDOWN")
    proc.kill("SIGKILL")
    expect(await proc.exited).not.toBe(0)
    const log = readFileSync(target, "utf8")
    expect(log).toContain('message="logged before the signal"')
    expect(log).toContain('message="shutdown started" signal=SIGTERM')
  } finally {
    proc.kill("SIGKILL")
  }
})

posix("the deadline's own error line is on disk when it exits the process", async () => {
  const target = path.join(dir, "deadline.log")
  const proc = spawn(target, 200, "hang")
  try {
    await readLine(proc.stdout, "SHUTDOWN_READY")
    proc.kill("SIGTERM")
    expect(await proc.exited).toBe(1)
    const log = readFileSync(target, "utf8")
    expect(log).toContain('message="logged before the signal"')
    expect(log).toMatch(/level=ERROR .*message="shutdown deadline exceeded"/)
  } finally {
    proc.kill("SIGKILL")
  }
})

test("a line logged before process.exit is on disk, with no teardown to flush it", async () => {
  const target = path.join(dir, "exit.log")
  const proc = spawn(target, 60_000, "exit")
  expect(await proc.exited).toBe(0)
  expect(readFileSync(target, "utf8")).toContain('message="logged before the signal"')
})

test("writeThroughFromNow puts the lines batched so far on disk at once", async () => {
  const target = path.join(dir, "through.log")
  const proc = spawn(target, 60_000, "through")
  try {
    await readLine(proc.stdout, "SHUTDOWN_READY")
    proc.kill("SIGKILL")
    await proc.exited
    expect(readFileSync(target, "utf8")).toContain('message="logged before the signal"')
  } finally {
    proc.kill("SIGKILL")
  }
})

function spawn(target: string, deadline: number, mode: "hang" | "exit" | "through") {
  return Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/shutdown-log.ts"), target, String(deadline), mode], {
    cwd: path.join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
}

const readers = new WeakMap<ReadableStream<Uint8Array>, { reader: ReadableStreamDefaultReader<Uint8Array>; text: string }>()

/** Reads `stream` until a line equal to `line` arrives; later calls on the same stream go on where the last one stopped. */
async function readLine(stream: ReadableStream<Uint8Array>, line: string) {
  const state = readers.get(stream) ?? { reader: stream.getReader(), text: "" }
  readers.set(stream, state)
  const decoder = new TextDecoder()
  while (true) {
    const lines = state.text.split("\n")
    const at = lines.indexOf(line)
    if (at >= 0) {
      state.text = lines.slice(at + 1).join("\n")
      return
    }
    const chunk = await state.reader.read()
    if (chunk.done) throw new Error(`the fixture ended before it printed ${line}; it printed: ${state.text}`)
    state.text += decoder.decode(chunk.value, { stream: true })
  }
}
