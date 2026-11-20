// A build, compiled by adjacent-config.test.ts: binds as the CLI does, reports what it loads (the config document the
// server reads, the TUI's cli config text) and the binding keys left in its environment, which its children inherit,
// then moves onto the next build named in its arguments the way a TUI moves (Reexec.replace with no handoff: execve,
// this process's environment carried).
import "../../src/adjacent-config"
import { cliConfigContent, configFile, KEYS } from "../../src/adjacent-config"
import { Reexec } from "../../src/reexec"

const [next, ...rest] = process.argv.slice(2)
console.log(
  JSON.stringify({
    build: process.execPath,
    loads: { config: configFile(), cli: cliConfigContent() },
    env: Object.fromEntries(KEYS.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))),
  }),
)
if (next !== undefined) {
  const code = await Reexec.replace({ command: [next], args: rest, env: {}, stay: {} }, ["/nonexistent/loop-probe-x"])
  process.exit(code)
}
