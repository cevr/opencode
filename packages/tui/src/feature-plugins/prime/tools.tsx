// Tool rows in the Prime look: one line per call with a status glyph, the
// input preview, line counts and duration; edited files and their diff bands
// under it; the error name in red when the call fails.
import type { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createMemo, For, Match, Show, Switch, type Accessor } from "solid-js"
import type { SessionMessageAssistantTool } from "@opencode/client"
import { GUTTER, usePart, type PartProps } from "./transcript"
import {
  countLabel,
  diffRows,
  duration,
  editedFiles,
  errorName,
  lineCounts,
  toolOutput,
  toolPreview,
  toolStatus,
  toolInput,
  type Detail,
  type DiffRow,
} from "./view"

type Context = Plugin.Context

function Glyph(props: { context: Context; part: SessionMessageAssistantTool }) {
  const theme = () => props.context.theme
  const glyph = createMemo((): { char: string; color: RGBA } => {
    const status = toolStatus(props.part)
    if (status === "done") return { char: "✓", color: theme().text.feedback.success.base }
    if (status === "failed") return { char: "✗", color: theme().text.feedback.error.base }
    if (status === "running") return { char: "◆", color: theme().text.feedback.success.base }
    return { char: "◇", color: theme().text.muted }
  })
  return <span style={{ fg: glyph().color }}>{glyph().char} </span>
}

export function ToolRow(props: PartProps & { tool: string; detail: Accessor<Detail> }) {
  const part = usePart(props)
  const tool = createMemo(() => {
    const item = part()
    return item?.type === "tool" ? item : undefined
  })
  return (
    <Show when={tool()}>
      {(item) => <ToolCell context={props.context} tool={props.tool} part={item()} detail={props.detail} />}
    </Show>
  )
}

function ToolCell(props: {
  context: Context
  tool: string
  part: SessionMessageAssistantTool
  detail: Accessor<Detail>
}) {
  const theme = () => props.context.theme
  const preview = createMemo(() => toolPreview(props.tool, toolInput(props.part)))
  const counts = createMemo(() => countLabel(lineCounts(props.tool, props.part)))
  const files = createMemo(() => editedFiles(props.part))
  const output = createMemo(() => toolOutput(props.part))
  const tail = createMemo(() => {
    const parts = [counts(), duration(props.part)].filter(Boolean)
    return parts.join(" · ")
  })
  const sep = () => <span style={{ fg: theme().border.base }}> · </span>
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" paddingLeft={GUTTER}>
        <text flexShrink={0} wrapMode="none">
          <Glyph context={props.context} part={props.part} />
          <span style={{ fg: theme().text.muted }}>{props.tool}</span>
          <Show when={preview()}>{sep()}</Show>
        </text>
        <text flexShrink={1} wrapMode="none" truncate fg={theme().text.faint}>
          {preview()}
        </text>
        <text flexShrink={0} wrapMode="none" fg={theme().text.faint}>
          {sep()}
          {tail()}
          <Show when={errorName(props.part)}>
            {(name) => (
              <>
                {sep()}
                <span style={{ fg: theme().text.feedback.error.base }}>{name()}</span>
              </>
            )}
          </Show>
        </text>
      </box>
      <For each={files()}>
        {(file) => (
          <>
            <box paddingLeft={GUTTER + 3}>
              <text wrapMode="none" fg={theme().text.faint}>
                ╰─ <span style={{ fg: theme().text.muted }}>{file.path}</span>{" "}
                <span style={{ fg: theme().text.feedback.success.base }}>+{file.additions}</span>{" "}
                <span style={{ fg: theme().text.feedback.error.base }}>-{file.deletions}</span>
              </text>
            </box>
            <Show when={props.detail() !== "overview"}>
              <DiffBands context={props.context} rows={diffRows(file.patch, props.detail() === "all" ? Infinity : 1)} />
            </Show>
          </>
        )}
      </For>
      <Show when={props.detail() === "all" && props.tool !== "patch" && output()}>
        <ShellTail context={props.context} output={output()} />
      </Show>
    </box>
  )
}

// Expanded output: the last five lines under a dim gutter.
function ShellTail(props: { context: Context; output: string }) {
  const lines = createMemo(() => props.output.replace(/\n+$/, "").split("\n"))
  const hidden = createMemo(() => Math.max(0, lines().length - 5))
  return (
    <box flexDirection="column" paddingLeft={GUTTER + 3}>
      <Show when={hidden()}>
        <text fg={props.context.theme.text.faint}>... {hidden()} earlier lines</text>
      </Show>
      <For each={lines().slice(-5)}>
        {(line, index) => (
          <text wrapMode="none" truncate fg={props.context.theme.text.muted}>
            <span style={{ fg: props.context.theme.text.faint }}>{index() === 0 ? "╰─ " : "   "}</span>
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

function DiffBands(props: { context: Context; rows: DiffRow[] }) {
  const theme = () => props.context.theme
  const width = createMemo(() =>
    Math.max(2, ...props.rows.map((row) => (row.kind === "gap" ? 0 : String(row.line).length))),
  )
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.rows}>
        {(row) => (
          <Switch>
            <Match when={row.kind === "gap"}>
              <text fg={theme().text.faint}> ⋮</text>
            </Match>
            <Match when={row.kind !== "gap" ? row : undefined}>
              {(line) => (
                <box
                  width="100%"
                  backgroundColor={
                    line().kind === "added"
                      ? theme().diff.background.added
                      : line().kind === "removed"
                        ? theme().diff.background.removed
                        : theme().diff.background.context
                  }
                >
                  <text wrapMode="none" truncate fg={theme().text.base}>
                    <span style={{ fg: line().kind === "context" ? theme().text.faint : theme().text.base }}>
                      {" "}
                      {String(line().line).padStart(width())}{" "}
                      {line().kind === "added" ? "+" : line().kind === "removed" ? "-" : " "}{" "}
                    </span>
                    {line().text}
                  </text>
                </box>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </box>
  )
}
