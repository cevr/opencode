import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"

// Adds a composer panel tab whose content counts ctrl+d presses while it is the active tab.
export default Plugin.define({
  id: "fixture.composer-tab",
  setup(context) {
    const [count, setCount] = createSignal(0)
    context.ui.composerTab({
      id: "probe",
      title: "Probe",
      hints: () => [{ label: "count", shortcut: "ctrl+d" }],
      render: (input) => {
        context.keymap.layer(() => ({
          mode: "composer",
          priority: 1,
          commands: [{ title: "Count", bind: "ctrl+d", run: () => void setCount((value) => value + 1) }],
        }))
        return <text>{`Probe for ${input.sessionID}: ${count()}`}</text>
      },
    })
  },
})
