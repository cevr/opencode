import { Plugin } from "@opencode/plugin/tui"

type Probe = {
  triggers: { providerID: string; modelID: string }[]
  dispose?: () => void
}

// Adds a "queue next" action to the host's model picker. Each trigger is recorded on a global the test reads, and
// the global holds the action's cleanup so the test can remove it while the picker is open.
export default Plugin.define({
  id: "fixture.model-picker-action",
  setup(context) {
    const probe = ((globalThis as { __modelPickerProbe?: Probe }).__modelPickerProbe ??= { triggers: [] })
    probe.dispose = context.ui.modelPickerAction({
      id: "queue",
      bind: "ctrl+g",
      title: "queue next",
      onTrigger: (model) => void probe.triggers.push(model),
    })
  },
})
