import { openSync, writeFileSync } from "node:fs"
import { Reexec } from "../../src/reexec"

// Holds a file open, then replaces itself as the scenario in argv[3] says, with shells that report their process id,
// the variable they got, and whether that file's descriptor crossed into them.
const [, , held, scenario, handoff] = process.argv
const fd = openSync(held!, "r")
console.log(`BEFORE ${process.pid} ${fd}`)
if (handoff) writeFileSync(handoff, "{}")
const report = (name: string, variable: string) => [
  "/bin/sh",
  "-c",
  `echo "${name} $$ $${variable}"; if [ -e /dev/fd/${fd} ]; then echo "FD open"; else echo "FD closed"; fi`,
]
const missing = ["/nonexistent/loop-probe-x"]
const plan = (command: ReadonlyArray<string>) => ({
  command,
  args: [],
  env: { REEXEC_PROBE: "carried" },
  stay: { REEXEC_STAY: "stayed" },
  handoff,
})
const code =
  scenario === "move"
    ? await Reexec.replace(plan(report("AFTER", "REEXEC_PROBE")), missing)
    : scenario === "stay"
      ? await Reexec.replace(plan(missing), report("STAYED", "REEXEC_STAY"))
      : await Reexec.replace(plan(missing), ["/nonexistent/loop-probe-y"])
console.log(`RETURNED ${code}`)
