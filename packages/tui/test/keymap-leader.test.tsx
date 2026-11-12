import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const timeout = createTuiResolvedConfig().leader.timeout
const LEADER = "\x18"

// Runs the keymap in a child process on its own stdin, a real pipe as a terminal's is, stalling `stall` ms in the
// input callback that read the leader (fixture/leader-stall.tsx), so the order in which the event loop runs an
// expired timer and reads a waiting key is the real one. Types each key, waiting its ms after it, and answers the
// commands that ran once `commands` of them did: `chord` for leader+F, `text f` for F alone.
async function type(input: {
  stall: number
  keys: readonly (readonly [key: string, waitMs: number])[]
  commands?: number
}) {
  const fixture = path.join(import.meta.dir, "fixture/leader-stall.tsx")
  const tui = spawn(process.execPath, [fixture, String(input.stall), String(input.commands ?? 1)], {
    cwd: path.join(import.meta.dir, ".."),
    detached: true,
    stdio: ["pipe", "pipe", "inherit"],
  })
  const lines: string[] = []
  let buffer = ""
  tui.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    const parts = buffer.split("\n")
    buffer = parts.pop() ?? ""
    lines.push(...parts)
  })
  const until = async (done: () => boolean) => {
    const deadline = Date.now() + 15_000
    while (!done() && Date.now() < deadline) await Bun.sleep(20)
  }
  try {
    await until(() => lines.includes("ready"))
    expect(lines).toContain("ready")
    for (const [key, waitMs] of input.keys) {
      tui.stdin.write(key)
      await Bun.sleep(waitMs)
    }
    await until(() => lines.length > 1)
    return lines.slice(1).map((line) => JSON.parse(line) as string[])
  } finally {
    // The fixture exits once it printed; a group left after that (a failed run) is killed.
    const exited = new Promise((resolve) => tui.once("exit", resolve))
    if (tui.exitCode === null && tui.signalCode === null) await Promise.race([exited, Bun.sleep(1_000)])
    if (tui.pid && tui.exitCode === null && tui.signalCode === null) process.kill(-tui.pid, "SIGKILL")
  }
}

// On a loaded machine the TUI's thread stalls while it handles input (the work a key or a burst of server events
// starts, a GC, the CPU taken away) for longer than the leader's timeout, while the next key, typed 200 ms after
// the leader, waits in the terminal's pipe. When the stall ends the chord still runs.
test("a leader chord typed in time survives a stall longer than the leader timeout", async () => {
  const keys = [[LEADER, 200], ["f", 0]] as const
  expect(await type({ stall: timeout + 500, keys })).toEqual([["chord"]])
}, 40_000)

test("the leader still times out when the next key comes after the timeout", async () => {
  const keys = [[LEADER, timeout + 300], ["f", 0]] as const
  expect(await type({ stall: 0, keys })).toEqual([["text f"]])
}, 40_000)

// The second leader comes before the first one's timeout would have fired; a chord that completes cancels its
// leader's timer, so that timer never clears the second leader before its F.
test("a second chord typed inside the first leader's timeout runs too", async () => {
  const keys = [[LEADER, 200], ["f", timeout - 500], [LEADER, 500], ["f", 0]] as const
  expect(await type({ stall: 0, keys, commands: 2 })).toEqual([["chord", "chord"]])
}, 40_000)
