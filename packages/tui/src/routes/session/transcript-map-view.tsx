import { RGBA, TextAttributes, type KeyEvent } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import type { SessionOutlineEntry } from "@opencode/client"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useClient } from "../../context/client"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { Spinner } from "../../component/spinner"
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
const WHO_WIDTH = 10
const WHEEL = 3

/**
 * The session's transcript as a map: shown in the transcript's own place while the session is in map mode, one line
 * per turn.
 */
export function TranscriptMapView(props: {
  sessionID: string
  /** The message at the top of the transcript when the map opened: its turn starts selected. */
  startMessageID?: string
  onJump: (turn: TranscriptMap.Turn) => void
  /** The turn's message actions (revert, copy, fork), the timeline's old Enter. */
  onActions: (turn: TranscriptMap.Turn) => void
  onClose: () => void
}) {
  const client = useClient()
  const renderer = useRenderer()
  const keymap = Keymap.use()
  const theme = useTheme()
  const [entries, setEntries] = createSignal(cachedOutline(client, props.sessionID))
  const [failed, setFailed] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [typing, setTyping] = createSignal(false)
  // The selected turn, by id, so a refreshed outline keeps the reader's place.
  const [selectedID, setSelectedID] = createSignal<string>()
  const [height, setHeight] = createSignal(0)
  const [top, setTop] = createSignal(0)

  // Keys belong to the map while it is open: the session's own bindings sit in the base mode, and the composer
  // gives up its focus so typed letters filter the map.
  onCleanup(keymap.mode.push("modal", () => true))
  const focused = renderer.currentFocusedRenderable
  focused?.blur()
  onCleanup(() => {
    if (focused && !focused.isDestroyed) focused.focus()
  })

  void loadOutline(client, props.sessionID).then(setEntries, (error: unknown) =>
    setFailed(error instanceof Error ? error.message : String(error)),
  )

  const turns = createMemo(() => TranscriptMap.turns(entries() ?? []))
  const search = createMemo(() => new Map(turns().map((turn) => [turn, TranscriptMap.searchText(turn)])))
  const shown = createMemo(() =>
    TranscriptMap.filter(turns(), query(), (turn) => search().get(turn) ?? TranscriptMap.searchText(turn)),
  )
  const rows = createMemo(() => TranscriptMap.rows(shown()))
  const selected = createMemo(() => {
    const list = shown()
    const id = selectedID()
    const index = id === undefined ? -1 : list.findIndex((turn) => turn.id === id)
    if (index !== -1) return index
    // Unfiltered and not moved yet: the turn holding the transcript's top message (ids ascend in time).
    const start = props.startMessageID
    const holding = start && !query() ? list.findLastIndex((turn) => turn.id <= start) : -1
    return holding === -1 ? list.length - 1 : holding
  })
  const rowOf = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (row.type === "turn") result.set(row.turn.id, index)
    })
    return result
  })

  // The list's first line always names the day of the turns below it, so a reader dropped into the middle of a
  // night's work knows which night it is; the rest of the lines are rows.
  const body = () => Math.max(0, height() - 1)
  // The first time the list has rows and room, the opening turn takes its top line, as it held the transcript's
  // top; after that, the selected turn is kept in view with the least scrolling.
  let placed = false
  createEffect(() => {
    const turn = shown()[selected()]
    const size = body()
    if (!turn || size <= 0) return setTop(0)
    const row = rowOf().get(turn.id) ?? 0
    const last = Math.max(0, rows().length - size)
    if (!placed) {
      placed = true
      return setTop(Math.min(row, last))
    }
    const current = top()
    if (row < current) setTop(row)
    else if (row >= current + size) setTop(row - size + 1)
    else if (current > Math.max(0, rows().length - size)) setTop(Math.max(0, rows().length - size))
  })
  const window = createMemo(() => {
    // A day label at the top would repeat the pinned one.
    const start = rows()[top()]?.type === "day" ? top() + 1 : top()
    return rows().slice(start, start + body())
  })
  const pinnedDay = createMemo(() => {
    const first = window().find((row) => row.type === "turn")
    return first?.type === "turn" ? TranscriptMap.day(first.turn.time) : undefined
  })

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
    props.onJump(turn)
  }

  const page = () => Math.max(1, height() - 1 || PAGE)
  // `/` starts typing a filter, vim-style: enter keeps it and returns the letters to moving, escape drops it.
  Keymap.createLayer(() => ({
    mode: "modal",
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
    enabled: () => !typing(),
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
          if (turn) props.onActions(turn)
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
    if (!typing() || event.defaultPrevented) return
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

  const whoColor = (turn: TranscriptMap.Turn) => {
    if (turn.kind === "user") return theme.text.base
    if (turn.kind === "agent") return theme.text.action.secondary.base
    return theme.text.feedback.info.base
  }

  return (
    <box id="transcript-map" flexGrow={1} minHeight={0} flexDirection="column">
      <box flexDirection="row" flexShrink={0} gap={2} paddingBottom={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text.base} flexShrink={0}>
          Transcript map
        </text>
        <text fg={theme.text.muted} flexShrink={0}>
          {entries() === undefined
            ? ""
            : query()
              ? `${shown().length} of ${turns().length} turns`
              : `${turns().length} turns`}
        </text>
        <text fg={typing() || query() ? theme.text.base : theme.text.muted} wrapMode="none" flexGrow={1} truncate>
          {typing() || query() ? `/${query()}${typing() ? "▏" : ""}` : "/ filters by text or a time (03:, Nov 17)"}
        </text>
      </box>
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
            <Show when={failed()} fallback={<Spinner color={theme.text.muted}>Reading the session…</Spinner>}>
              {(message) => <text fg={theme.text.feedback.error.base}>{message()}</text>}
            </Show>
          }
        >
          <Show when={rows().length > 0} fallback={<text fg={theme.text.muted}>No turns match</text>}>
            <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
              {`— ${pinnedDay() ?? ""} —`}
            </text>
            <For each={window()}>
              {(row) => {
                if (row.type === "day")
                  return (
                    <text fg={theme.text.muted} wrapMode="none">
                      {`— ${row.label} —`}
                    </text>
                  )
                const active = () => shown()[selected()]?.id === row.turn.id
                return (
                  <box
                    flexDirection="row"
                    gap={2}
                    flexShrink={0}
                    backgroundColor={active() ? theme.background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)}
                    onMouseUp={() => {
                      setSelectedID(row.turn.id)
                      jump()
                    }}
                  >
                    <text fg={active() ? theme.text.action.primary.focused : theme.text.muted} flexShrink={0}>
                      {TranscriptMap.clock(row.turn.time)}
                    </text>
                    <text fg={active() ? theme.text.action.primary.focused : whoColor(row.turn)} flexShrink={0}>
                      {row.turn.who.padEnd(WHO_WIDTH).slice(0, WHO_WIDTH)}
                    </text>
                    <text
                      fg={active() ? theme.text.action.primary.focused : theme.text.base}
                      flexGrow={1}
                      wrapMode="none"
                      truncate
                    >
                      {row.turn.gist}
                    </text>
                  </box>
                )
              }}
            </For>
          </Show>
        </Show>
      </box>
      <box flexDirection="row" flexShrink={0} gap={3}>
        <text fg={theme.text.muted} wrapMode="none">
          {typing()
            ? "enter keep filter · esc drop filter · ↑↓ move"
            : "↑↓ j/k move · PgUp/PgDn page · g/G first/last · / filter · enter go there · a actions · esc back"}
        </text>
      </box>
    </box>
  )
}
