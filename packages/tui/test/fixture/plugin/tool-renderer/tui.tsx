import { Plugin } from "@opencode/plugin/tui"

// Draws every tool call itself through the session.part.tool slot and asks
// for an ungrouped transcript with reasoning shown.
export default Plugin.define({
  id: "fixture.tool-renderer",
  setup(context) {
    context.ui.layout({ transcript: { grouping: "none", thinking: "show" } })
    context.ui.slot({
      replace: "session.part.tool",
      render: (input) => {
        const command = () => {
          const message = context.data.session.message.get(input.sessionID, input.messageID)
          if (message?.type !== "assistant") return ""
          const item = message.content.find((part) => part.type === "tool" && part.id === input.partID)
          if (item?.type !== "tool" || typeof item.state.input === "string") return ""
          return String((item.state.input as { command?: unknown }).command ?? "")
        }
        return (
          <text>
            Custom {input.tool} row: {command()}
          </text>
        )
      },
    })
  },
})
