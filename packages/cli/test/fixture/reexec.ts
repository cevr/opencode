import { openSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Reexec } from "../../src/reexec"

// A TUI moving onto another build, as the scenario in argv[3] says. The builds are shells that report their process
// id or their parent's, the variables they got, and whether the file this process holds open crossed into them. A
// build "comes up" by deleting its handoff, as a TUI does once its screen is up.
const [, , held, scenario, dir] = process.argv
const fd = openSync(held!, "r")
console.log(`BEFORE ${process.pid} ${fd}`)
const handoff = path.join(dir!, `${process.pid}-${scenario}.json`)
writeFileSync(handoff, "{}")
const shell = (script: string) => ["/bin/sh", "-c", script]
const fdState = `if [ -e /dev/fd/${fd} ]; then echo "FD open"; else echo "FD closed"; fi`
const comesUp = (name: string) =>
  shell(`echo "${name} $$ $PPID $REEXEC_PROBE"; ${fdState}; rm -f "$OPENCODE_TUI_HANDOFF"; exit 0`)
const stays = shell(`echo "STAYED $$ $OPENCODE_TUI_STAYED $([ -f "$OPENCODE_TUI_HANDOFF" ] && echo drafts)"; exit 0`)
const plan = (command: ReadonlyArray<string>, file?: string) => ({
  command,
  args: [],
  env: { REEXEC_PROBE: "carried", ...(file ? { OPENCODE_TUI_HANDOFF: file } : {}) },
  stay: { OPENCODE_TUI_STAYED: "new-build", ...(file ? { OPENCODE_TUI_HANDOFF: file } : {}) },
  handoff: file,
})
const missing = ["/nonexistent/loop-probe-x"]
const code = await (() => {
  switch (scenario) {
    case "move":
      return Reexec.replace(plan(comesUp("AFTER"), handoff), stays)
    case "crash":
      return Reexec.replace(plan(shell('echo "CRASHED"; exit 1'), handoff), stays)
    case "missing":
      return Reexec.replace(plan(missing, handoff), stays)
    case "lost":
      return Reexec.replace(plan(missing, handoff), ["/nonexistent/loop-probe-y"])
    case "again":
      // The build it moves onto moves again in turn, from under the watcher.
      return Reexec.replace(plan([process.execPath, import.meta.path, held!, "again-inner", dir!], handoff), stays)
    case "again-inner":
      // Up: it takes the handoff it came with.
      rmSync(process.env.OPENCODE_TUI_HANDOFF!, { force: true })
      return Reexec.replace(plan(comesUp("SECOND"), handoff), stays)
    default:
      // No handoff: the build replaces this process directly.
      return Reexec.replace(plan(comesUp("DIRECT")), missing)
  }
})()
console.log(`RETURNED ${code}`)
process.exit(code)
