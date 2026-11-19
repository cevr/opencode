import { expect, test } from "bun:test"
import { Global } from "@opencode/util/global"
import { rootsOutsideScratchHome } from "./fixture/scratch-home"

// Guards test/preload.ts: without its useScratchHome call, a direct `bun test` reads the developer's auth.json and config.
test("global data, config, cache, state and log roots are in the scratch home", () => {
  expect(rootsOutsideScratchHome(Global.Path)).toEqual([])
})
