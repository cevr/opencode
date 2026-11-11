import { openSync } from "node:fs"
import { Reexec } from "../../src/reexec"

// Holds a file open, then replaces itself with a shell that reports its process id, the variable the plan adds, and
// whether that file's descriptor crossed into it.
const fd = openSync(process.argv[2]!, "r")
console.log(`BEFORE ${process.pid} ${fd}`)
const code = await Reexec.replace({
  command: ["/bin/sh", "-c"],
  args: [`echo "AFTER $$ $REEXEC_PROBE"; if [ -e /dev/fd/${fd} ]; then echo "FD open"; else echo "FD closed"; fi`],
  env: { REEXEC_PROBE: "carried" },
})
console.log(`RETURNED ${code}`)
