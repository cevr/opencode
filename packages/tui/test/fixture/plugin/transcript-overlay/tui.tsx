import { Plugin } from "@opencode/plugin/tui"

// Reports the transcript overlay's input over the transcript's top row, and
// reveals message-5 when clicked.
export default Plugin.define({
  id: "fixture.transcript-overlay",
  setup(context) {
    context.ui.slot({
      append: "session.transcript.overlay",
      render: (input) => {
        const top = () => input.messages.findLast((message) => message.row <= 0)
        const target = () => input.messages.find((message) => message.messageID === "message-5")
        return (
          <box height={1} backgroundColor={context.theme.background.base} onMouseUp={() => input.reveal("message-5")}>
            <text>
              Overlay away={String(input.away)} top={top()?.messageID ?? "none"}@{top()?.row ?? "-"} target=
              {target()?.row ?? "unmounted"}
            </text>
          </box>
        )
      },
    })
  },
})
