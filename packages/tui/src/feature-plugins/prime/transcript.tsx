// Transcript rows in the Prime look: a full-width band for the user prompt,
// one dim line of reasoning, and plain assistant text.
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show, type Accessor } from "solid-js"
import type { SessionMessageUser } from "@opencode/client"
// Gap: a plugin cannot reach the host's syntax style or markdown node
// renderer; see the report's `ui.markdown` entry.
import { useThemes } from "../../context/theme"
import { usePlugin } from "../../plugin/context"
import { findPart, type Detail } from "./view"

type Context = Plugin.Context
export type PartProps = { context: Context; sessionID: string; messageID: string; partID: string }

/** Transcript rows sit one column in from the inset; bands reach the inset. */
export const GUTTER = 1

export function usePart(props: PartProps) {
  return createMemo(() =>
    findPart(props.context.data.session.message.get(props.sessionID, props.messageID), props.partID),
  )
}

export function UserBand(props: { context: Context; sessionID: string; messageID: string }) {
  const message = createMemo(() => {
    const item = props.context.data.session.message.get(props.sessionID, props.messageID)
    return item?.type === "user" ? (item as SessionMessageUser) : undefined
  })
  return (
    <Show when={message()}>
      {(item) => (
        <box
          width="100%"
          backgroundColor={props.context.theme.background.raised.base}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={props.context.theme.text.base}>{item().text.trim()}</text>
        </box>
      )}
    </Show>
  )
}

export function ReasoningLine(props: PartProps & { detail: Accessor<Detail> }) {
  const part = usePart(props)
  const content = createMemo(() => {
    const item = part()
    if (item?.type !== "reasoning") return ""
    return item.text.replace("[REDACTED]", "").trim()
  })
  return (
    <Show when={props.detail() !== "overview" && content()}>
      <box paddingLeft={GUTTER}>
        <text fg={props.context.theme.text.muted} wrapMode={props.detail() === "all" ? "word" : "none"} truncate>
          {props.detail() === "all" ? content() : content().split("\n")[0]}
        </text>
      </box>
    </Show>
  )
}

export function AssistantText(props: PartProps) {
  const part = usePart(props)
  const { currentSyntax: syntax } = useThemes()
  const plugins = usePlugin()
  const content = createMemo(() => {
    const item = part()
    return item?.type === "text" ? item.text.trim() : ""
  })
  const streaming = createMemo(
    () =>
      props.context.data.session.message.get(props.sessionID, props.messageID)?.type === "assistant" &&
      (props.context.data.session.message.get(props.sessionID, props.messageID) as { time: { completed?: number } })
        .time.completed === undefined,
  )
  return (
    <Show when={content()}>
      <box paddingLeft={GUTTER} flexShrink={0}>
        <markdown
          syntaxStyle={syntax()}
          renderNode={plugins.markdown()}
          content={content()}
          streaming={streaming()}
          internalBlockMode="top-level"
          tableOptions={{ style: "grid", cellPaddingX: 1 }}
          conceal={true}
          fg={props.context.theme.markdown.text}
          bg={props.context.theme.background.base}
        />
      </box>
    </Show>
  )
}
