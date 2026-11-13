import { Plugin } from "@opencode/plugin/tui"

// Takes over the background-work panel's tab bar, rows and footer, drawing what each slot's input says.
export default Plugin.define({
  id: "fixture.composer-panel",
  setup(context) {
    context.ui.slot({
      replace: "session.composer.panel.tabs",
      render: (input) => (
        <text>{`Tabs ${input.tabs.map((tab) => tab.id).join("|")} active ${input.active}${input.open ? " open" : ""}`}</text>
      ),
    })
    context.ui.slot({
      replace: "session.composer.panel.row",
      render: (input) => (
        <text>{`Row ${input.tab} ${input.id} of ${input.ids.length} "${input.label}"${input.selected ? " selected" : ""}`}</text>
      ),
    })
    context.ui.slot({
      replace: "session.composer.panel.footer",
      render: (input) => (
        <text>{`Footer ${input.hints.map((hint) => `${hint.label}=${hint.shortcut}`).join(",")} tabs ${input.tabs}`}</text>
      ),
    })
  },
})
