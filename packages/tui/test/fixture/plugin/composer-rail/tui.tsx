import { Plugin } from "@opencode/plugin/tui"

// Picks the bare rail composer.
export default Plugin.define({
  id: "fixture.composer-rail",
  setup(context) {
    context.ui.layout({ composer: { chrome: "rail" } })
  },
})
