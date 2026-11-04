// The frame around the transcript in the Prime look: a one-line top bar and
// a text splash.
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo } from "solid-js"
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
