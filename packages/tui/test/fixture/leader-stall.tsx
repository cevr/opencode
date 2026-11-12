/** @jsxImportSource @opentui/solid */
// A TUI keymap on this process's stdin that stalls for `argv[2]` ms in the input callback that reads the leader,
// as a loaded machine stalls the TUI's thread. It prints `ready` once listening, then the commands that ran as one
// JSON line once `argv[3]` of them ran (default 1; or after 10 s), and exits. Run by test/keymap-leader.test.tsx.
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { createTuiResolvedConfig } from "./tui-runtime"

const stall = Number(process.argv[2])
const expected = Number(process.argv[3] ?? 1)
const calls: string[] = []

function Harness() {
  Keymap.createLayer(() => ({
    commands: [
      { id: "demo.chord", bind: "<leader>f", run: () => void calls.push("chord") },
      { id: "demo.text", bind: "f", run: () => void calls.push("text f") },
    ],
  }))
  return <box />
}

const app = await testRender(
  () => (
    <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider>
        <Harness />
      </Keymap.Provider>
    </ConfigProvider>
  ),
  { stdin: process.stdin },
)
// After the renderer's own listener, so the leader is handled (its timeout armed) before the stall.
process.stdin.on("data", (chunk: Buffer) => {
  if (chunk.includes(0x18)) Bun.sleepSync(stall)
})
process.stdout.write("ready\n")
const deadline = Date.now() + 10_000
while (calls.length < expected && Date.now() < deadline) await Bun.sleep(20)
await Bun.sleep(100)
process.stdout.write(`${JSON.stringify(calls)}\n`)
app.renderer.destroy()
process.exit(0)
