import { Plugin } from "@opencode/plugin/tui"

// Claims compactions, reading each one's status through the session data.
export default Plugin.define({
  id: "fixture.compaction-row",
  setup(context) {
    context.ui.slot({
      replace: "session.message.compaction",
      render: (input) => {
        const status = () => {
          const message = context.data.session.message.get(input.sessionID, input.messageID)
          return message?.type === "compaction" ? message.status : "?"
        }
        return (
          <text>
            Compaction claimed: {input.messageID} {status()}
          </text>
        )
      },
    })
  },
})
