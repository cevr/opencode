import { Plugin } from "@opencode/plugin/tui"

// Draws each collapsed turn of the transcript map in its own words, to show what the slot's input carries.
export default Plugin.define({
  id: "fixture.map-turn",
  setup(context) {
    context.ui.slot({
      replace: "session.map.turn",
      render: (input) => (
        <text>
          {`Map ${input.kind} ${input.messageID} [${input.text}] ${input.thoughts}/${input.tools}${input.selected ? " selected" : ""}`}
        </text>
      ),
    })
  },
})
