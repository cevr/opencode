import { expect, test } from "bun:test"
import { SourceRun } from "./source-run.js"

test("a JavaScript runtime runs from source; any other executable is a build", () => {
  for (const runtime of ["/usr/local/bin/bun", "/usr/bin/node", "/opt/nodejs", "/opt/bun/Bun.exe", "bun"])
    expect(SourceRun.fromSource(runtime)).toBe(true)
  for (const build of ["/Users/x/.local/share/opencode-prime/opencode-2.2.7-prime.1.2.tree", "/usr/bin/opencode"])
    expect(SourceRun.fromSource(build)).toBe(false)
})
