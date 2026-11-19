import { useScratchHome } from "./fixture/scratch-home"

useScratchHome()
process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
