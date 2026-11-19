import { expect, test } from "bun:test"
import os from "os"
import { Global } from "@opencode/util/global"
import { rootsOutsideScratchHome } from "../../core/test/fixture/scratch-home"

// Guards test/preload.ts: without its useScratchHome call, server tests read the developer's auth.json and config.
test("global roots, the home directory and spawned children stay in the scratch home", () => {
  expect(rootsOutsideScratchHome(Global.Path, os.homedir())).toEqual([])
})
