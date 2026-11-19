import { expect, test } from "bun:test"
import { Global } from "@opencode/util/global"
import { rootsOutsideScratchHome } from "../../core/test/fixture/scratch-home"

// Guards test/preload.ts: without its useScratchHome call, cli tests write the developer's log and read their config.
test("global data, config, cache, state and log roots are in the scratch home", () => {
  expect(rootsOutsideScratchHome(Global.Path)).toEqual([])
})
