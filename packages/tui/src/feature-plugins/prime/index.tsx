// The Prime Agent look for the session screen, built on public slots and
// ui.layout. Opt-in: enable it with `"plugins": ["opencode.prime"]` in the
// tui config, and pair it with a Prime palette theme.
import { Plugin } from "@opencode/plugin/tui"
import type { TranscriptRowKind } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { Splash, TopBar } from "./chrome"
import { ToolRow } from "./tools"
import { AssistantText, ReasoningLine, UserBand } from "./transcript"
import { type Detail } from "./view"

// Blank rows between transcript rows. Overview packs everything; Details
// and All keep a blank line around prose but stack tool calls tight.
export function rowGap(detail: Detail, row: { kind: TranscriptRowKind; previous?: TranscriptRowKind }) {
  if (detail === "overview") return 0
  if (row.kind === "footer") return 0
  if (row.kind === "tool" && row.previous === "tool") return 0
  if (row.kind === "reasoning" && row.previous === "user") return 0
  return 1
}

export default Plugin.define({
  id: "opencode.prime",
  setup(context) {
    const [detail] = createSignal<Detail>("details")

    context.ui.layout({
      inset: 1,
      rowGap: (row) => rowGap(detail(), row),
    })

    context.ui.slot({
      append: "session.header",
      render: (input) => <TopBar context={context} sessionID={input.sessionID} />,
    })
    context.ui.slot({
      append: "session.transcript.start",
      render: (input) => <Splash context={context} sessionID={input.sessionID} />,
    })
    context.ui.slot({
      replace: "session.message.user",
      render: (input) => <UserBand context={context} sessionID={input.sessionID} messageID={input.messageID} />,
    })
    context.ui.slot({
      replace: "session.part.reasoning",
      render: (input) => <ReasoningLine context={context} {...input} detail={detail} />,
    })
    context.ui.slot({
      replace: "session.part.text",
      render: (input) => <AssistantText context={context} {...input} />,
    })
    context.ui.slot({
      replace: "session.part.tool",
      render: (input) => <ToolRow context={context} {...input} detail={detail} />,
    })
    // Prime closes a turn with nothing: no agent, model or duration line.
    context.ui.slot({ replace: "session.message.assistant.footer", render: () => null })
  },
})
