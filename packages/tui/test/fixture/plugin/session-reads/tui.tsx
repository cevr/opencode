import { Plugin } from "@opencode/plugin/tui"
import { TextRenderable } from "@opentui/core"

// Reads a text part through data.session.message.get and renders it with ui.Markdown.
export default Plugin.define({
  id: "fixture.session-reads",
  setup(context) {
    context.markdown.registerCodeBlockRenderer(
      "probe",
      () => new TextRenderable(context.renderer, { content: "Probe fence rendered", height: 1 }),
    )
    context.ui.slot({
      replace: "session.part.text",
      render: (input) => {
        const content = () => {
          const message = context.data.session.message.get(input.sessionID, input.messageID)
          if (message?.type !== "assistant") return ""
          const ordinal = Number(input.partID.replace(/^text:/, ""))
          const item = message.content.filter((part) => part.type === "text")[ordinal]
          return item?.type === "text" ? `Read ${input.partID}: ${item.text}` : ""
        }
        return <context.ui.Markdown content={content()} />
      },
    })
  },
})
