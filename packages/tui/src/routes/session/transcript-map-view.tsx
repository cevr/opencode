import { RGBA, type KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import type { SessionOutlineEntry } from "@opencode/client"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { useLocal } from "../../context/local"
import { useTheme } from "../../context/theme"
import { Slot } from "../../plugin/render"
import { SplitBorder } from "../../ui/border"
import { useDialog } from "../../ui/dialog"
import { Spinner } from "../../component/spinner"
import { INLINE_TOOL_ICON_WIDTH, useRowGutter } from "./message-parts"
import { TranscriptMap } from "./transcript-map"

type Client = ReturnType<typeof useClient>

// Each client's outlines, by session: a map opened again reads only the messages written since.
const outlines = new WeakMap<Client, Map<string, readonly SessionOutlineEntry[]>>()

/** A session's outline, extended from the copy read before when there is one. */
export async function loadOutline(client: Client, sessionID: string) {
  let cache = outlines.get(client)
  if (!cache) outlines.set(client, (cache = new Map()))
  const cached = cache.get(sessionID)
  // The newest message can still be growing (a step streaming its text), so it is read again.
  const kept = cached?.slice(0, -1)
  const after = kept?.at(-1)?.id
  const entries = after
    ? await client.api.message
        .outline({ sessionID, after })
        .then((tail) => [...kept!, ...tail])
        // The message it extends from is gone (a revert): read the session whole.
        .catch(() => client.api.message.outline({ sessionID }))
    : await client.api.message.outline({ sessionID })
  cache.set(sessionID, entries)
  return entries
}

/** The outline read before, shown while the map reads what is new. */
export function cachedOutline(client: Client, sessionID: string) {
  return outlines.get(client)?.get(sessionID)
}

const PAGE = 10
const WHEEL = 3
const transparent = RGBA.fromInts(0, 0, 0, 0)

/**
 * The session's transcript with every turn collapsed to one line, in the transcript's own place and look: a prompt
 * as the transcript draws a prompt, an agent's run as its first sentence and its work, a notice as the transcript
 * heads it. There is no chrome of its own; a filter line shows only while one is typed or kept.
 */
export function TranscriptMapView(props: {
  sessionID: string
  /** The message at the top of the transcript when the map opened: its turn starts selected. */
  startMessageID?: string
  /** The screen line that message's turn started on in the transcript, kept for its collapsed line. */
  startRow?: number
  /** Cells right of the transcript's rows (its scrollbar), so a right-aligned time lines up with the transcript's. */
  rightGap?: number
  /** Expands the transcript at the turn; `row` is the line its collapsed row was on, where its start should land. */
  onJump: (turn: TranscriptMap.Turn, row: number) => void
  /** The turn's message actions (revert, copy, fork), the timeline's old Enter. */
  onActions: (turn: TranscriptMap.Turn, row: number) => void
  onClose: () => void
}) {
  const client = useClient()
  const keymap = Keymap.use()
  const theme = useTheme()
  const dialog = useDialog()
  const gutter = useRowGutter()
  // A dialog opened over the map (the session list, the palette) holds the keys until it closes.
  const free = () => dialog.stack.length === 0
  const [entries, setEntries] = createSignal(cachedOutline(client, props.sessionID))
  const [failed, setFailed] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [typing, setTyping] = createSignal(false)
  // The selected turn, by id, so a refreshed outline keeps the reader's place.
  const [selectedID, setSelectedID] = createSignal<string>()
  const [height, setHeight] = createSignal(0)
  // The first row on the map's top line; below zero while the opening turn keeps a line lower than the rows above it
  // could fill.
  const [top, setTop] = createSignal(0)

  // Keys belong to the map while it is open: the session's own bindings sit in the base mode, and the session
  // disables its prompt (no focus) for as long as the map is shown, so typed letters filter the map.
  onCleanup(keymap.mode.push("modal", () => true))

  // The outline is read fresh: until then the copy read before may not hold the turns written since.
  const [fresh, setFresh] = createSignal(false)
  void loadOutline(client, props.sessionID).then(
    (read) => {
      setEntries(read)
      setFresh(true)
    },
    (error: unknown) => setFailed(error instanceof Error ? error.message : String(error)),
  )

  const turns = createMemo(() => TranscriptMap.turns(entries() ?? []))
  const search = createMemo(() => new Map(turns().map((turn) => [turn, TranscriptMap.searchText(turn)])))
  const shown = createMemo(() =>
    TranscriptMap.filter(turns(), query(), (turn) => search().get(turn) ?? TranscriptMap.searchText(turn)),
  )
  const rows = createMemo(() => TranscriptMap.rows(shown()))
  // The turn holding the transcript's top message, found by its place in the session (not by id: a notice keeps the
  // id it was queued with); -1 when there is none, or the outline read so far does not hold it yet.
  const opening = createMemo(() => {
    const start = props.startMessageID
    if (!start || query()) return -1
    return TranscriptMap.holding(shown(), entries() ?? [], start)
  })
  const selected = createMemo(() => {
    const list = shown()
    const id = selectedID()
    const index = id === undefined ? -1 : list.findIndex((turn) => turn.id === id)
    if (index !== -1) return index
    // Unfiltered and not moved yet: the turn holding the transcript's top message.
    const start = opening()
    return start === -1 ? list.length - 1 : start
  })
  const rowOf = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (row.type === "turn") result.set(row.turn.id, index)
    })
    return result
  })

  const filtering = () => typing() || query() !== ""
  const body = () => Math.max(0, height() - (filtering() ? 1 : 0))
  // The first time the map has rows and room, the opening turn takes the line it started on in the transcript, so the
  // transcript reads as folding in place; after that, the selected turn is kept in view with the least scrolling.
  let placed = false
  createEffect(() => {
    const turn = shown()[selected()]
    const size = body()
    if (!turn || size <= 0) return
    const row = rowOf().get(turn.id) ?? 0
    if (!placed) {
      // A copy read before that lacks the opening turn waits for the fresh read rather than placing the wrong one.
      if (props.startMessageID && !query() && opening() === -1 && !fresh() && !failed()) return
      placed = true
      return setTop(row - Math.max(0, Math.min(size - 1, props.startRow ?? 0)))
    }
    const current = top()
    // Scrolling up to a day's first turn brings its day's label into view with it.
    if (row < current) setTop(rows()[row - 1]?.type === "day" ? row - 1 : row)
    else if (row >= current + size) setTop(row - size + 1)
  })
  const window = createMemo(() => {
    const list = rows()
    const start = top()
    const result: (TranscriptMap.MapRow | undefined)[] = []
    for (let line = start; line < start + body(); line++) result.push(list[line])
    // A row past the ends is a blank line: the turns the map opened at keep their line.
    return result.map((row) => row ?? ({ type: "gap" } as const))
  })
  /** The screen line a turn's collapsed row is on. */
  const lineOf = (turn: TranscriptMap.Turn) => Math.max(0, (rowOf().get(turn.id) ?? 0) - top())

  const move = (delta: number) => {
    const list = shown()
    if (list.length === 0) return
    const next = Math.max(0, Math.min(list.length - 1, selected() + delta))
    setSelectedID(list[next]!.id)
  }
  const moveTo = (index: number) => {
    const turn = shown()[index]
    if (turn) setSelectedID(turn.id)
  }
  const jump = () => {
    const turn = shown()[selected()]
    if (!turn) return
    props.onJump(turn, lineOf(turn))
  }

  const page = () => Math.max(1, body() - 1 || PAGE)
  // `/` starts typing a filter, vim-style: enter keeps it and returns the letters to moving, escape drops it.
  Keymap.createLayer(() => ({
    mode: "modal",
    enabled: free,
    commands: [
      {
        bind: "escape",
        title: "Close the map",
        group: "Transcript map",
        run: () => {
          if (typing()) return stopTyping(false)
          props.onClose()
        },
      },
      {
        bind: "return",
        title: "Jump to the turn",
        group: "Transcript map",
        run: () => (typing() ? stopTyping(true) : jump()),
      },
      { bind: "up,ctrl+p", title: "Previous turn", group: "Transcript map", run: () => move(-1) },
      { bind: "down,ctrl+n", title: "Next turn", group: "Transcript map", run: () => move(1) },
      { bind: "pageup", title: "Page up", group: "Transcript map", run: () => move(-page()) },
      { bind: "pagedown", title: "Page down", group: "Transcript map", run: () => move(page()) },
      { bind: "home", title: "First turn", group: "Transcript map", run: () => moveTo(0) },
      { bind: "end", title: "Last turn", group: "Transcript map", run: () => moveTo(shown().length - 1) },
    ],
  }))
  Keymap.createLayer(() => ({
    mode: "modal",
    enabled: () => free() && !typing(),
    commands: [
      { bind: "k", title: "Previous turn", group: "Transcript map", run: () => move(-1) },
      { bind: "j", title: "Next turn", group: "Transcript map", run: () => move(1) },
      { bind: "g", title: "First turn", group: "Transcript map", run: () => moveTo(0) },
      { bind: "shift+g", title: "Last turn", group: "Transcript map", run: () => moveTo(shown().length - 1) },
      { bind: "/", title: "Filter", group: "Transcript map", run: () => setTyping(true) },
      {
        bind: "a",
        title: "Message actions",
        group: "Transcript map",
        run: () => {
          const turn = shown()[selected()]
          if (turn) props.onActions(turn, lineOf(turn))
        },
      },
    ],
  }))
  const stopTyping = (keep: boolean) => {
    setTyping(false)
    if (!keep) setQuery("")
  }
  // While a filter is typed, every printable key goes into it.
  useKeyboard((event: KeyEvent) => {
    if (!typing() || !free() || event.defaultPrevented) return
    if (event.name === "backspace") {
      event.preventDefault()
      if (query() === "") return setTyping(false)
      return setQuery((value) => value.slice(0, -1))
    }
    if (event.ctrl && event.name === "u") return (event.preventDefault(), setQuery(""))
    if (event.ctrl || event.meta || event.option) return
    const char = event.sequence
    if (!char || char.length !== 1 || char < " ") return
    event.preventDefault()
    setQuery((value) => value + char)
    setSelectedID(undefined)
  })

  return (
    <box id="transcript-map" flexGrow={1} minHeight={0} flexDirection="column" paddingRight={props.rightGap ?? 0}>
      <box
        flexGrow={1}
        minHeight={0}
        flexDirection="column"
        onSizeChange={function () {
          setHeight(this.height)
        }}
        onMouseScroll={(event) => {
          if (event.scroll?.direction === "up") move(-WHEEL)
          if (event.scroll?.direction === "down") move(WHEEL)
        }}
      >
        <Show
          when={entries() !== undefined}
          fallback={
            <box paddingLeft={gutter()}>
              <Show when={failed()} fallback={<Spinner color={theme.text.muted}>Reading the session…</Spinner>}>
                {(message) => <text fg={theme.text.feedback.error.base}>{message()}</text>}
              </Show>
            </box>
          }
        >
          <Show
            when={rows().length > 0}
            fallback={
              <box paddingLeft={gutter()}>
                <text fg={theme.text.muted}>No turns match</text>
              </box>
            }
          >
            <For each={window()}>
              {(row) => (
                <Switch fallback={<box height={1} flexShrink={0} />}>
                  <Match when={row.type === "day" ? row : undefined}>
                    {(day) => (
                      <box height={1} flexShrink={0} flexDirection="row" justifyContent="center">
                        <text fg={theme.text.muted} wrapMode="none">
                          {day().label}
                        </text>
                      </box>
                    )}
                  </Match>
                  <Match when={row.type === "turn" ? row.turn : undefined}>
                    {(turn) => {
                      const active = () => shown()[selected()]?.id === turn().id
                      return (
                        <box
                          id={`transcript-map-turn-${turn().id}`}
                          height={1}
                          flexShrink={0}
                          flexDirection="row"
                          backgroundColor={active() ? theme.background.raised.base : transparent}
                          onMouseUp={() => {
                            setSelectedID(turn().id)
                            jump()
                          }}
                        >
                          <Slot
                            path="session.map.turn"
                            input={{
                              sessionID: props.sessionID,
                              messageID: turn().id,
                              kind: turn().kind,
                              text: turn().gist,
                              source: turn().source,
                              thoughts: turn().thoughts,
                              tools: turn().tools,
                              time: turn().time,
                              get selected() {
                                return active()
                              },
                            }}
                          >
                            <MapTurn sessionID={props.sessionID} turn={turn()} selected={active()} />
                          </Slot>
                        </box>
                      )
                    }}
                  </Match>
                </Switch>
              )}
            </For>
          </Show>
        </Show>
      </box>
      <Show when={filtering()}>
        <box height={1} flexShrink={0} flexDirection="row" paddingLeft={gutter()} gap={2}>
          <text fg={theme.text.base} wrapMode="none" flexGrow={1} truncate>
            {`/${query()}${typing() ? "▏" : ""}`}
          </text>
          <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
            {`${shown().length} of ${turns().length} turns`}
          </text>
        </box>
      </Show>
    </box>
  )
}

/**
 * A collapsed turn in the host's transcript look: a prompt behind its agent-coloured bar, a run's first sentence in
 * the prose colour with its work as the transcript's `+ N thoughts, M tools` row says it and the time it ended at the
 * right, a notice with the glyph and colours the transcript heads it with.
 */
function MapTurn(props: { sessionID: string; turn: TranscriptMap.Turn; selected: boolean }) {
  const theme = useTheme()
  const gutter = useRowGutter()
  const local = useLocal()
  const data = useData()
  const work = () => TranscriptMap.work(props.turn)
  const stop = () => TranscriptMap.completion(props.turn)
  const stopColor = (state: TranscriptMap.NoticeState) => {
    if (state === "failed") return theme.text.feedback.error.base
    if (state === "cancelled") return theme.text.feedback.warning.base
    return theme.text.feedback.info.base
  }
  return (
    <Switch>
      <Match when={props.turn.kind === "user"}>
        <box
          flexGrow={1}
          border={["left"]}
          borderColor={local.agent.color(data.session.get(props.sessionID)?.agent ?? "build")}
          customBorderChars={SplitBorder.customBorderChars}
          backgroundColor={props.selected ? theme.decrease(theme.background.raised.base) : theme.background.raised.base}
          paddingLeft={2}
          paddingRight={2}
        >
          <text fg={theme.text.base} wrapMode="none" truncate>
            {props.turn.gist}
          </text>
        </box>
      </Match>
      <Match when={props.turn.kind === "agent"}>
        <box flexGrow={1} flexDirection="row" paddingLeft={gutter()} gap={1}>
          <text fg={theme.markdown.text} wrapMode="none" truncate flexGrow={1}>
            {props.turn.gist}
            <Show when={work()}>
              {(done) => <span style={{ fg: theme.text.muted }}>{`${props.turn.gist ? " · " : ""}+ ${done()}`}</span>}
            </Show>
          </text>
          <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
            {TranscriptMap.clock(props.turn.time)}
          </text>
        </box>
      </Match>
      <Match when={stop()}>
        {(notice) => (
          <box flexGrow={1} paddingLeft={gutter()}>
            <text wrapMode="none" truncate>
              <span style={{ fg: stopColor(notice().state) }}>
                {`${notice().state === "finished" ? "↳" : "!"} ${notice().actor} ${notice().state}`}
              </span>
              <Show when={notice().task}>
                <span style={{ fg: theme.text.muted }}>{` · ${notice().task}`}</span>
              </Show>
            </text>
          </box>
        )}
      </Match>
      <Match when={props.turn.kind === "compaction"}>
        <box flexGrow={1} flexDirection="row" alignItems="center">
          <box border={["top"]} borderColor={theme.text.muted} flexGrow={1} />
          <box paddingLeft={1} paddingRight={1}>
            <text fg={theme.text.muted}>{props.turn.gist}</text>
          </box>
          <box border={["top"]} borderColor={theme.text.muted} flexGrow={1} />
        </box>
      </Match>
      <Match when={true}>
        <box flexGrow={1} flexDirection="row" paddingLeft={gutter()}>
          <text width={INLINE_TOOL_ICON_WIDTH} fg={theme.text.muted} flexShrink={0}>
            {props.turn.source === "goal" ? "◎" : props.turn.source === "mail" ? "✉" : "◈"}
          </text>
          <text fg={theme.text.muted} wrapMode="none" truncate flexGrow={1}>
            {props.turn.gist}
          </text>
        </box>
      </Match>
    </Switch>
  )
}
