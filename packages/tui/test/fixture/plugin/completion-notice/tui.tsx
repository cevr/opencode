import { Plugin } from "@opencode/plugin/tui"

// Claims completion notices and stacks notices tight.
export default Plugin.define({
  id: "fixture.completion-notice",
  setup(context) {
    context.ui.layout({ rowGap: (row) => (row.kind === "notice" && row.previous === "notice" ? 0 : 1) })
    context.ui.slot({
      replace: "session.message.completion",
      render: (input) => <text>Completion claimed: {input.messageID}</text>,
    })
  },
})
