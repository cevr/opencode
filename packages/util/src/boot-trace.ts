// A start's timeline, for measuring it: with OPENCODE_BOOT_TRACE=<dir>, `mark(name)` records the ms
// since the process started at each step of the boot, and with OPENCODE_BOOT_TRACE_PROFILE=1 a CPU
// profile runs from the first import. Both are written to <dir> (`boot-<pid>.json`,
// `boot-<pid>.cpuprofile`) once `finish()` runs or OPENCODE_BOOT_TRACE_MS (default 15000) passes.
// Without the variable every call does nothing.
export * as BootTrace from "./boot-trace.js"

import { Session } from "node:inspector"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const dir = process.env.OPENCODE_BOOT_TRACE || undefined
const marks: Array<{ readonly name: string; readonly ms: number }> = []
let profiler: Session | undefined
let done = false

export const enabled = dir !== undefined

/** Records `name` at the ms since this process started. */
export function mark(name: string) {
  if (dir === undefined || done) return
  marks.push({ name, ms: Math.round(performance.now() * 10) / 10 })
}

/** Starts the CPU profile; the first module the binary evaluates calls it. */
export function start() {
  if (dir === undefined || marks.length > 0) return
  mark("trace start")
  setTimeout(finish, Number(process.env.OPENCODE_BOOT_TRACE_MS ?? 15_000)).unref()
  if (!process.env.OPENCODE_BOOT_TRACE_PROFILE) return
  profiler = new Session()
  profiler.connect()
  profiler.post("Profiler.enable")
  profiler.post("Profiler.setSamplingInterval", { interval: 500 })
  profiler.post("Profiler.start")
}

/** Writes the marks and the profile, once. */
export function finish() {
  if (dir === undefined || done) return
  mark("trace end")
  done = true
  mkdirSync(dir, { recursive: true })
  const base = path.join(dir, `boot-${process.pid}`)
  writeFileSync(`${base}.json`, JSON.stringify({ pid: process.pid, timeOrigin: performance.timeOrigin, marks }, null, 2))
  const session = profiler
  if (session === undefined) return
  session.post("Profiler.stop", (error, result) => {
    session.disconnect()
    if (!error) writeFileSync(`${base}.cpuprofile`, JSON.stringify(result.profile))
  })
}
