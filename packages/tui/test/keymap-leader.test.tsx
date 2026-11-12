import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const timeout = createTuiResolvedConfig().leader.timeout

// Runs the keymap in a child process on its own stdin, a real pipe as a terminal's is, stalling `stall` ms in the
// input callback that read the leader (fixture/leader-stall.tsx), so the order in which the event loop runs an
// expired timer and reads a waiting key is the real one. Types the leader (Ctrl+X), then F `gap` ms later, and
// answers the commands that ran: `chord` for leader+F, `text f` for F alone.
async function chord(input: { stall: number; gap: number }) {
  const tui = spawn(process.execPath, [path.join(import.meta.dir, "fixture/leader-stall.tsx"), String(input.stall)], {
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
    tui.stdin.write("\x18")
    await Bun.sleep(input.gap)
    tui.stdin.write("f")
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
  expect(await chord({ stall: timeout + 500, gap: 200 })).toEqual([["chord"]])
}, 40_000)

test("the leader still times out when the next key comes after the timeout", async () => {
  expect(await chord({ stall: 0, gap: timeout + 300 })).toEqual([["text f"]])
}, 40_000)
