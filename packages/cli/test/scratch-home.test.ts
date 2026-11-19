import { expect, test } from "bun:test"
import os from "os"
import { Global } from "@opencode/util/global"
import { rootsOutsideScratchHome } from "../../core/test/fixture/scratch-home"

// Guards test/preload.ts: without its useScratchHome call, cli tests write the developer's log and data directories.
test("global roots, the home directory and spawned children stay in the scratch home", () => {
  expect(rootsOutsideScratchHome(Global.Path, os.homedir())).toEqual([])
})
