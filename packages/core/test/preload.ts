import { useScratchHome } from "./fixture/scratch-home"

// Direct `bun test` invocations bypass `packages/core/script/test.ts`: useScratchHome isolates the home, XDG and
// temporary roots before any module reads them (it does nothing when script/test.ts already did).
useScratchHome()
process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
