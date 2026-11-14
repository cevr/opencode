import { Plugin } from "@opencode/plugin/tui"

// A subagent's view opens on its prompt, not on the Subagents picker.
export default Plugin.define({
  id: "fixture.subagent-picker-closed",
  setup(context) {
    context.ui.layout({ composer: { subagentPicker: "closed" } })
  },
})
