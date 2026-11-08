import { Plugin } from "@opencode/plugin/tui"

// Claims the queued-prompts box above the composer, listing the session's waiting prompts itself.
export default Plugin.define({
  id: "fixture.queued-box",
  setup(context) {
    context.ui.slot({
      replace: "session.composer.queued",
      render: (input) => {
        const texts = () =>
          context.data.session.pending
            .list(input.sessionID)
            .flatMap((item) => (item.type === "user" ? [item.payload.text] : []))
            .join(", ")
        return <text>Queued box: {texts()}</text>
      },
    })
  },
})
