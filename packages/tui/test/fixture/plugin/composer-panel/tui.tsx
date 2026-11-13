import { Plugin } from "@opencode/plugin/tui"

/** A Terminals row's terminal, as its input carries it: title, command, state, exit code, process in front. */
const terminal = (shown?: {
  readonly title: string
  readonly command: string
  readonly status: "running" | "exited"
  readonly exitCode?: number
  readonly foregroundProcess?: string
}) => {
  if (!shown) return ""
  const exit = shown.exitCode === undefined ? "" : ` ${shown.exitCode}`
  const front = shown.foregroundProcess ? ` fg ${shown.foregroundProcess}` : ""
  return ` terminal ${shown.title} [${shown.command}] ${shown.status}${exit}${front}`
}

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
        <text>{`Row ${input.tab} ${input.id} of ${input.ids.length} "${input.label}"${input.selected ? " selected" : ""}${input.tab === "terminals" ? terminal(input.terminal) : ""}`}</text>
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
