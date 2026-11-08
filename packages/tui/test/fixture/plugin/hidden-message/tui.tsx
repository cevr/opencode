import { Plugin } from "@opencode/plugin/tui"

// Draws nothing for the prompt `msg_ask` and, through the layout rule's
// `messageID`, gives its row no gap either: the hidden prompt takes no space.
export default Plugin.define({
  id: "fixture.hidden-message",
  setup(context) {
    context.ui.layout({ rowGap: (row) => (row.messageID === "msg_ask" ? 0 : 1) })
    context.ui.slot({ append: "session.transcript.start", render: () => <text>Transcript start claimed</text> })
    context.ui.slot({
      replace: "session.message.user",
      render: (input) => (input.messageID === "msg_ask" ? null : <text>User band</text>),
    })
  },
})
