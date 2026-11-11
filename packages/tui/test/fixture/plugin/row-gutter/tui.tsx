import { Plugin } from "@opencode/plugin/tui"

// Starts every transcript row one cell in from a one-cell inset.
export default Plugin.define({
  id: "fixture.row-gutter",
  setup(context) {
    context.ui.layout({ inset: 1, gutter: 1 })
  },
})
