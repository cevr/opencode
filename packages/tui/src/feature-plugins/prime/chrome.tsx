// The frame around the transcript in the Prime look: a one-line top bar, a
// text splash, the detail-mode hint above the editor, and the tray, rule and
// activity line under it.
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show, type Accessor } from "solid-js"
// Gaps: context usage and the goal are host internals today; see the
// report's `data.session.usage` and `data.session.goal` entries.
import { contextUsage, formatContextUsage } from "../../util/session"
import { createGoal } from "../prompt/goal"
import { detailHint, type Detail } from "./view"
import { GUTTER } from "./transcript"

type Context = Plugin.Context

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function TopBar(props: { context: Context; sessionID: string }) {
  const title = createMemo(() => props.context.data.session.get(props.sessionID)?.title ?? "")
  const cost = createMemo(() => money.format(props.context.data.session.cost(props.sessionID)))
  return (
    <box height={1} flexShrink={0} flexDirection="row" justifyContent="center">
      <text wrapMode="none" truncate fg={props.context.theme.text.base}>
        {title()}
        <span style={{ fg: props.context.theme.text.faint }}>
          {"  "}
          {cost()}
        </span>
      </text>
    </box>
  )
}

function modelLabel(context: Context) {
  const model = context.ui.model.current()
  if (!model) return ""
  return `${model.providerID}/${model.modelID}`
}

export function Splash(props: { context: Context; sessionID: string }) {
  const theme = () => props.context.theme
  const cwd = createMemo(() => {
    const directory = props.context.data.session.get(props.sessionID)?.location.directory
    return directory ? props.context.ui.format.path(directory) : ""
  })
  const line = (label: string, value: string) => (
    <text wrapMode="none" truncate fg={theme().text.base}>
      <span style={{ fg: theme().text.muted }}>{label} </span>
      {value}
    </text>
  )
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={GUTTER} marginTop={1}>
      {line("opencode", `v${props.context.app.version}`)}
      {line("model", modelLabel(props.context))}
      {line("cwd", cwd())}
    </box>
  )
}

export function ModeHint(props: { context: Context; detail: Accessor<Detail> }) {
  return (
    <box flexDirection="row" justifyContent="flex-end" marginTop={1} flexShrink={0}>
      <text wrapMode="none" fg={props.context.theme.text.faint}>
        {detailHint(props.detail())}
      </text>
    </box>
  )
}

export function Dock(props: { context: Context; sessionID?: string }) {
  const theme = () => props.context.theme
  const data = props.context.data
  const usage = createMemo(() => {
    if (!props.sessionID) return
    const session = data.session.get(props.sessionID)
    if (!session) return
    const value = contextUsage(
      data.session.message.list(props.sessionID),
      data.location.model.list(session.location),
      session.revert?.messageID,
    )
    return value ? formatContextUsage(value.tokens, value.percent) : undefined
  })
  const model = createMemo(() => {
    const current = props.context.ui.model.current()
    if (!current) return ""
    return current.variant ? `${current.modelID}:${current.variant}` : current.modelID
  })
  const subagents = createMemo(() => {
    if (!props.sessionID) return 0
    const id = props.sessionID
    return data.session.family(id).filter((child) => child !== id && data.session.status(child) === "running").length
  })
  const shells = createMemo(() => {
    if (!props.sessionID) return 0
    return data.shell.list(props.context.location).filter((shell) => shell.metadata.sessionID === props.sessionID)
      .length
  })
  const goal = createGoal(props.context, () => props.sessionID)
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
  const sep = () => <span style={{ fg: theme().text.faint }}>{"  ·  "}</span>
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1}>
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text wrapMode="none" fg={theme().text.muted}>
          ← manage
        </text>
        <text wrapMode="none" truncate fg={theme().text.faint}>
          {[model(), usage()].filter(Boolean).join(" · ")}
        </text>
      </box>
      <box height={1} border={["top"]} borderColor={theme().border.base} />
      <text wrapMode="none" truncate fg={theme().text.faint} paddingLeft={GUTTER}>
        <span style={{ fg: subagents() ? theme().text.feedback.success.base : theme().text.faint }}>
          ◆ {plural(subagents(), "subagent")}
        </span>
        {sep()}
        <span style={{ fg: shells() ? theme().text.feedback.success.base : theme().text.faint }}>
          ▸ {plural(shells(), "shell")}
        </span>
        {sep()}
        <Show when={goal()} fallback={<span style={{ fg: theme().text.faint }}>goal</span>}>
          <span style={{ fg: theme().text.feedback.warning.base }}>goal</span>
        </Show>
      </text>
    </box>
  )
}
