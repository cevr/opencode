import { Plugin } from "@opencode/plugin/tui"

// Reports ui.sidebar.visible above the composer.
export default Plugin.define({
  id: "fixture.sidebar-visible",
  setup(context) {
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <text>Sidebar probe: {context.ui.sidebar.visible(input.sessionID) ? "shown" : "hidden"}</text>
      ),
    })
  },
})
