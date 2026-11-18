import {
  RGBA,
  type BoxRenderable,
  type KeyEvent,
  type ScrollAcceleration,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import type { SessionOutlineEntry } from "@opencode/client"
import { SessionOutline } from "@opencode/core/session/outline"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js"
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

const ENTRY_KEYS = ["id", "type", "time", "completed", "summary", "source", "tools", "thoughts"] as const
/** Two folds of the held messages that read alike, entry by entry. */
function sameEntries(a: readonly SessionOutlineEntry[], b: readonly SessionOutlineEntry[]) {
  return a.length === b.length && a.every((entry, index) => ENTRY_KEYS.every((key) => entry[key] === b[index]![key]))
}
const TURN_KEYS = ["id", "kind", "time", "who", "gist", "tools", "thoughts", "source"] as const
/** Two map rows that draw alike. */
function sameRow(a: TranscriptMap.MapRow, b: TranscriptMap.MapRow) {
  if (a.type === "turn" && b.type === "turn") return TURN_KEYS.every((key) => a.turn[key] === b.turn[key])
  if (a.type === "day" && b.type === "day") return a.label === b.label
  return a.type === b.type
}

/** The outline's entries read in each older page: a few screens of turns, a small read whatever the session's size. */
export const OUTLINE_PAGE = 300
/** Rows mounted on each side of where the map opens, and added each time the reader scrolls near an end. */
const CHUNK = 200
/** The loading row's lines at the top while older rows wait to mount: its spinner and a blank line, as the transcript's. */
const LOADING = 2
const LOADING_ID = "transcript-map-earlier"
const LEAD_ID = "transcript-map-lead"
const transparent = RGBA.fromInts(0, 0, 0, 0)

/**
 * The session's transcript with every turn collapsed to one line, in the transcript's own place, look and scrolling: a
 * prompt as the transcript draws a prompt, an agent's run as its first sentence and its work, a notice as the
 * transcript heads it. The wheel, the page keys and the scrollbar scroll it as they scroll the transcript; a click
 * unfolds the transcript at a turn. There is no chrome of its own; a filter line shows only while one is typed or kept.
 */
export function TranscriptMapView(props: {
  sessionID: string
  /** The message at the top of the transcript when the map opened: its turn starts selected. */
  startMessageID?: string
  /** The screen line that message's turn started on in the transcript, kept for its collapsed line. */
  startRow?: number
  /** The transcript was at its bottom: the map opens at its own, and follows new turns there as the transcript does. */
  atBottom?: boolean
  /** The transcript's scrollbar setting and wheel speed, so the folded transcript scrolls as the transcript does. */
  scrollbar?: boolean
  scrollAcceleration?: ScrollAcceleration
  /** The map's scroll box while it is shown: the session's page keys scroll it. */
  scrollRef?: (scroll: ScrollBoxRenderable | undefined) => void
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
  const data = useData()
  // The messages the transcript already holds, folded here as the server's outline folds them: the map opens on them
  // at once. Equal entries keep the last array, so a step streaming its text redraws nothing until its line changes.
  const held = createMemo(
    () =>
      data.session.message
        .list(props.sessionID)
        .map((message) => SessionOutline.entry(message) satisfies SessionOutlineEntry),
    undefined,
    { equals: sameEntries },
  )
  // The outline of the older messages, read a page at a time as the reader nears the top; none is read on open
  // unless the held turns cannot fill the screen.
  const [older, setOlder] = createSignal<readonly SessionOutlineEntry[]>([])
  const [reachedStart, setReachedStart] = createSignal(false)
  /** Nothing older is left to read: the transcript holds the session's start, or the pages reached it. */
  const done = () => reachedStart() || !data.session.message.more(props.sessionID)
  const entries = createMemo(() => {
    const newer = held()
    const earlier = older()
    if (earlier.length === 0) return newer
    // The transcript may have loaded some of the same messages since: each is kept once, where it falls.
    const ids = new Set(newer.map((entry) => entry.id))
    return [...earlier.filter((entry) => !ids.has(entry.id)), ...newer]
  })
  const [failed, setFailed] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [typing, setTyping] = createSignal(false)
  // The selected turn, by id, so a refreshed outline keeps the reader's place. Only the keys move it.
  const [selectedID, setSelectedID] = createSignal<string>()
  // The turn under the mouse, lit as the selected one is.
  const [hoveredID, setHoveredID] = createSignal<string>()
  // The scroll box's height: the lines the folded transcript shows.
  const [height, setHeight] = createSignal(0)
  // The rows mounted, as the transcript mounts its own: a span around where the map opened, grown as the reader
  // scrolls near either end.
  const [range, setRange] = createSignal<{ start: number; end: number }>()
  // Blank lines above the first row and below the last, so the turn the map opened at can keep its line when the rows
  // above or below it could not fill the screen. The ones below give way as the reader scrolls up.
  const [lead, setLead] = createSignal(0)
  const [tail, setTail] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined
  // Turn rows by id, to read where one is on screen.
  const nodes = new Map<string, BoxRenderable>()

  // Keys belong to the map while it is open: the session's own bindings sit in the base mode, and the session
  // disables its prompt (no focus) for as long as the map is shown, so typed letters filter the map.
  onCleanup(keymap.mode.push("modal", () => true))

  let disposed = false
  onCleanup(() => (disposed = true))
  // The page being read, shared by every caller; `all` reads the rest of the session in one (a filter, the first turn).
  let reading: Promise<void> | undefined
  const readOlder = (all = false): Promise<void> => {
    if (done()) return Promise.resolve()
    if (reading) return all ? reading.then(() => readOlder(true)) : reading
    const before = entries()[0]?.id
    reading = client.api.message
      .outline({ sessionID: props.sessionID, before, limit: all ? undefined : OUTLINE_PAGE })
      .then(
        (page) => {
          if (disposed) return
          batch(() => {
            setFailed(undefined)
            if (page.length > 0) setOlder((list) => [...page, ...list])
            if (all || page.length < OUTLINE_PAGE) setReachedStart(true)
            // Nothing was older: the loading row goes, and the blank lines above take its place, so no row moves.
            if (page.length === 0 && (range()?.start ?? 0) === 0 && lead() > 0) setLead((blank) => blank + LOADING)
          })
          // The page's rows wait above the mounted ones; they mount as the rows near them do.
          if (scroll && !scroll.isDestroyed) scroll.afterLayout(() => grow())
        },
        (error: unknown) => {
          if (!disposed) setFailed(error instanceof Error ? error.message : String(error))
        },
      )
      .finally(() => (reading = undefined))
    return reading
  }

  const turns = createMemo(() => TranscriptMap.turns(entries()))
  // Read only while a filter is typed or kept: a session's thousands of turns are not formatted to be shown.
  const search = createMemo(() =>
    query() ? new Map(turns().map((turn) => [turn, TranscriptMap.searchText(turn)])) : undefined,
  )
  const shown = createMemo(() =>
    TranscriptMap.filter(turns(), query(), (turn) => search()?.get(turn) ?? TranscriptMap.searchText(turn)),
  )
  // Rows that read the same keep their object, so a page read above or a turn added below mounts only what is new.
  let kept = new Map<string, TranscriptMap.MapRow>()
  const rows = createMemo(() => {
    const result = TranscriptMap.rows(shown())
    const next = new Map<string, TranscriptMap.MapRow>()
    // A day label and a blank line are known by the turn they stand above.
    let below = ""
    for (let index = result.length - 1; index >= 0; index--) {
      const row = result[index]!
      if (row.type === "turn") below = row.turn.id
      const key = row.type === "turn" ? `turn:${below}` : `${row.type}:${row.type === "day" ? row.label : ""}:${below}`
      const prior = kept.get(key)
      if (prior && sameRow(prior, row)) result[index] = prior
      next.set(key, result[index]!)
    }
    kept = next
    return result
  })
  // The turn holding the transcript's top message, found by its place in the session (not by id: a notice keeps the
  // id it was queued with); -1 when there is none.
  const opening = createMemo(() => {
    const start = props.startMessageID
    if (!start || query()) return -1
    return TranscriptMap.holding(shown(), entries(), start)
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
  // The rows themselves, not wrappers, so the rows already mounted stay mounted as the span grows.
  const mounted = createMemo(() => {
    const span = range()
    return span ? rows().slice(span.start, span.end) : []
  })

  const filtering = () => typing() || query() !== ""
  const chunk = () => Math.max(CHUNK, height() * 2)
  // Until a placement has laid out, the box's sizes are the rows before it: its scroll events say nothing yet.
  let settled = false
  // Placed at the bottom: when the whole session turns out to fit the screen, it shows from its start instead.
  let bottomed = false
  /** The loading row shows above the mounted rows while rows wait to mount or older turns wait to be read. */
  const loadingShown = (start = range()?.start ?? 0) => start > 0 || !done()
  /** Mounts the rows around `row` and scrolls so it sits on screen line `line`. */
  const place = (row: number, line: number) => {
    const list = rows()
    const size = height()
    const start = Math.max(0, row - chunk())
    const end = Math.min(list.length, row + chunk())
    // The lines above the row: the loading row's, the mounted rows', and at the top the blank lines that keep the row
    // on its line when too few rows are there yet.
    const before = (loadingShown(start) ? LOADING : 0) + row - start
    const blank = start === 0 ? Math.max(0, line - before) : 0
    const above = blank + before
    const top = Math.max(0, above - line)
    settled = false
    batch(() => {
      setRange({ start, end })
      setLead(blank)
      setTail(end === list.length ? Math.max(0, top + size - (above + end - row)) : 0)
    })
    if (!scroll || scroll.isDestroyed) return
    scroll.scrollTo(top)
    scroll.afterLayout(() => {
      // The rows are laid out: the place holds now, before the blank lines below may be trimmed against it.
      scroll!.scrollTop = top
      settled = true
      grow()
    })
  }

  // The first time the map has rows and room, it opens where the transcript was. At the transcript's bottom, or near
  // enough to the end that the turns below would not reach the bottom line, the last turn sits on the bottom line with
  // the turns before it filling the screen above, as the transcript sits; elsewhere the opening turn takes the line it
  // started on in the transcript, so the transcript reads as folding in place. It opens on the turns the transcript
  // holds, at once; older ones are read as the reader nears them.
  createEffect(() => {
    if (range()) return
    const turn = shown()[selected()]
    const size = height()
    if (size <= 0) return
    // The transcript holds no turn to show (only model-facing messages): read back until one shows.
    if (!turn) return void untrack(() => readOlder())
    const last = rows().length - 1
    const row = rowOf().get(turn.id) ?? 0
    const line = Math.max(0, Math.min(size - 1, props.startRow ?? 0))
    // The turns from the opening one down would leave blank lines below the last: the map sits at its bottom instead,
    // as the transcript never shows space below its end. While older turns are still to read, the last turn takes the
    // bottom line even when the held ones cannot fill the screen: the loading row sits above them, and pages are read
    // until the screen is full.
    if (props.atBottom || line + last - row < size - 1) {
      bottomed = true
      return untrack(() => place(last, done() ? Math.min(size - 1, last) : size - 1))
    }
    untrack(() => place(row, line))
  })
  // A filter typed or dropped shows its rows from the selected turn. Rows read above, or turns added below, leave the
  // mounted rows mounted where they now are; the turns added at the end mount when the end was mounted.
  createEffect(
    on([rows, query], ([list, filter], previous) => {
      const span = untrack(range)
      if (!span || !previous) return
      const [before, last] = previous
      if (filter !== last) {
        const turn = untrack(() => shown()[selected()])
        const row = turn ? (untrack(rowOf).get(turn.id) ?? 0) : 0
        return untrack(() => place(row, Math.min(height() - 1, row)))
      }
      const index = new Map(list.map((row, at) => [row, at]))
      const shownBefore = before.slice(span.start, span.end)
      const first = shownBefore.findIndex((row) => index.has(row))
      const end = span.end >= before.length ? list.length : undefined
      if (first === -1) {
        setRange({ start: Math.min(span.start, list.length), end: end ?? Math.min(span.end, list.length) })
        return
      }
      const lastKept = shownBefore.findLastIndex((row) => index.has(row))
      setRange({
        start: Math.max(0, index.get(shownBefore[first]!)! - first),
        end: end ?? Math.min(list.length, index.get(shownBefore[lastKept]!)! + 1 + (shownBefore.length - 1 - lastKept)),
      })
    }),
  )

  /**
   * Mounts more rows when the reader nears either end of the mounted ones, and reads the older page when the reader
   * nears the top of all that is read; trims the blank lines left below.
   */
  let growing = false
  const grow = () => {
    if (!settled || growing || !scroll || scroll.isDestroyed) return
    const span = range()
    if (!span) return
    const size = scroll.viewport.height
    const spare = tail()
    if (spare > 0) {
      const needed = Math.max(0, scroll.scrollTop + size - (scroll.scrollHeight - spare))
      if (needed < spare) setTail(needed)
    }
    // Within two screens of the top, as the transcript asks for its older page, so a fast wheel finds rows there.
    const near = scroll.scrollTop <= size * 2
    if (span.start > 0 && near) {
      growing = true
      // The rows on screen keep their place as rows mount above them and the loading row goes.
      const node = scroll
        .getChildren()
        .find(
          (node) =>
            node.id !== LOADING_ID &&
            node.id !== LEAD_ID &&
            node.height > 0 &&
            node.y + node.height > scroll!.viewport.y,
        )
      const release = node ? scroll.anchor(node) : undefined
      const start = Math.max(0, span.start - chunk())
      // The blank lines kept above the first rows give way to the rows that now fill them.
      const added = span.start - start + ((loadingShown(start) ? LOADING : 0) - LOADING)
      batch(() => {
        setRange({ start, end: span.end })
        if (lead() > 0) setLead((blank) => Math.max(0, blank - added))
      })
      const was = node?.y
      scroll.afterLayout(() => {
        release?.()
        // A row that still moved (the anchor gave way to a change made in the same frame) is put back.
        if (node && was !== undefined && !node.isDestroyed && scroll && !scroll.isDestroyed && node.y !== was)
          scroll.scrollBy(node.y - was)
        growing = false
        grow()
      })
      return
    }
    if (span.start === 0 && !done()) {
      if (near) void readOlder()
    } else if (span.start === 0 && bottomed && lead() > 0) {
      // Every turn is read and still the screen is not full: the session fits, and shows whole from its start.
      bottomed = false
      setLead(0)
      scroll.scrollTo(0)
    }
    if (span.end < rows().length && scroll.scrollTop + size >= scroll.scrollHeight - size * 2)
      setRange({ start: span.start, end: Math.min(rows().length, span.end + chunk()) })
  }
  const onScroll = () => {
    // The rows moved under the mouse: what it was over is no longer under it. The renderer lights the row now under
    // it after the frame.
    setHoveredID(undefined)
    grow()
  }
  onCleanup(() => {
    scroll?.verticalScrollBar.off("change", onScroll)
    props.scrollRef?.(undefined)
  })

  /** The screen line a turn's collapsed row is on. */
  const lineOf = (turn: TranscriptMap.Turn) => {
    const node = nodes.get(turn.id)
    if (!node || node.isDestroyed || !scroll || scroll.isDestroyed) return 0
    return Math.max(0, node.y - scroll.viewport.y)
  }
  /** Scrolls the least that shows the selected turn, and its day's label when it is the day's first. */
  const reveal = (index: number, direction: number) => {
    const turn = shown()[index]
    const row = turn ? rowOf().get(turn.id) : undefined
    if (row === undefined || !scroll || scroll.isDestroyed) return
    const labelled = rows()[row - 1]?.type === "day"
    const span = range()
    if (!span || row < span.start || row >= span.end) {
      // Far from what is mounted: mount around it, at the top when it lies above, else at the bottom.
      return place(row, direction < 0 ? (labelled ? 1 : 0) : Math.max(0, height() - 1))
    }
    if (labelled && direction < 0) scroll.scrollChildIntoView(`transcript-map-day-${row - 1}`, { align: "nearest" })
    scroll.scrollChildIntoView(`transcript-map-turn-${turn!.id}`, { align: "nearest" })
  }
  const moveTo = (index: number) => {
    const list = shown()
    if (list.length === 0) return
    const next = Math.max(0, Math.min(list.length - 1, index))
    const direction = next - selected()
    setSelectedID(list[next]!.id)
    reveal(next, direction)
  }
  const move = (delta: number) => moveTo(selected() + delta)
  /** The session's first turn: the turns not read yet are read first, in one request. */
  const toFirst = () => {
    if (done()) return moveTo(0)
    void readOlder(true).then(() => {
      if (!disposed && done()) moveTo(0)
    })
  }
  // The row a mouse button went down on.
  let pressed: string | undefined
  const jump = (turn = shown()[selected()]) => {
    if (!turn) return
    props.onJump(turn, lineOf(turn))
  }

  // `/` starts typing a filter, vim-style: enter keeps it and returns the letters to moving, escape drops it. The page
  // keys are the session's own: they scroll the folded transcript as they scroll the transcript.
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
      { bind: "home", title: "First turn", group: "Transcript map", run: () => toFirst() },
      { bind: "end", title: "Last turn", group: "Transcript map", run: () => moveTo(shown().length - 1) },
    ],
  }))
  Keymap.createLayer(() => ({
    mode: "modal",
    enabled: () => free() && !typing(),
    commands: [
      { bind: "k", title: "Previous turn", group: "Transcript map", run: () => move(-1) },
      { bind: "j", title: "Next turn", group: "Transcript map", run: () => move(1) },
      { bind: "g", title: "First turn", group: "Transcript map", run: () => toFirst() },
      { bind: "shift+g", title: "Last turn", group: "Transcript map", run: () => moveTo(shown().length - 1) },
      { bind: "/", title: "Filter", group: "Transcript map", run: () => startTyping() },
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
  // A filter reads every turn, so the turns not read yet are read once, in one request, as it starts.
  const startTyping = () => {
    setTyping(true)
    void readOlder(true)
  }
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
    batch(() => {
      setQuery((value) => value + char)
      setSelectedID(undefined)
    })
  })

  return (
    <box id="transcript-map" flexGrow={1} minHeight={0} flexDirection="column">
      {/* The transcript's own scroll box: the same scrollbar, padding and wheel speed. */}
      <scrollbox
        ref={(box: ScrollBoxRenderable) => {
          scroll = box
          box.verticalScrollBar.on("change", onScroll)
          props.scrollRef?.(box)
        }}
        viewportOptions={{
          paddingRight: props.scrollbar ? 1 : 0,
        }}
        verticalScrollbarOptions={{
          paddingLeft: 1,
          visible: props.scrollbar ?? false,
          trackOptions: {
            backgroundColor: theme.decrease(theme.background.raised.base),
            foregroundColor: theme.border.base,
          },
        }}
        flexGrow={1}
        minHeight={0}
        stickyScroll={props.atBottom ?? false}
        stickyStart="bottom"
        scrollAcceleration={props.scrollAcceleration}
        onSizeChange={function () {
          setHeight(this.height)
        }}
      >
        <Show when={lead() > 0}>
          <box id={LEAD_ID} height={lead()} flexShrink={0} />
        </Show>
        <Show when={range() !== undefined && loadingShown()}>
          <box id={LOADING_ID} paddingLeft={gutter()} paddingBottom={LOADING - 1} flexShrink={0}>
            <Show when={failed()} fallback={<Spinner color={theme.text.muted}>Loading earlier turns…</Spinner>}>
              {(message) => (
                <text fg={theme.text.feedback.error.base} wrapMode="none" truncate>
                  {message()}
                </text>
              )}
            </Show>
          </box>
        </Show>
        <Show
          when={rows().length > 0}
          fallback={
            <box paddingLeft={gutter()} flexShrink={0}>
              <text fg={theme.text.muted}>No turns match</text>
            </box>
          }
        >
          <For each={mounted()}>
            {(row, index) => (
              <Switch fallback={<box height={1} flexShrink={0} />}>
                <Match when={row.type === "day" ? row : undefined}>
                  {(day) => (
                    <box
                      id={`transcript-map-day-${(range()?.start ?? 0) + index()}`}
                      height={1}
                      flexShrink={0}
                      flexDirection="row"
                      justifyContent="center"
                    >
                      <text fg={theme.text.muted} wrapMode="none">
                        {day().label}
                      </text>
                    </box>
                  )}
                </Match>
                <Match when={row.type === "turn" ? row.turn : undefined}>
                  {(turn) => {
                    const lit = () => shown()[selected()]?.id === turn().id || hoveredID() === turn().id
                    return (
                      <box
                        id={`transcript-map-turn-${turn().id}`}
                        ref={(node: BoxRenderable) => {
                          const id = turn().id
                          nodes.set(id, node)
                          onCleanup(() => {
                            if (nodes.get(id) === node) nodes.delete(id)
                          })
                        }}
                        height={1}
                        flexShrink={0}
                        flexDirection="row"
                        backgroundColor={lit() ? theme.background.raised.base : transparent}
                        onMouseOver={() => setHoveredID(turn().id)}
                        onMouseOut={() => setHoveredID((id) => (id === turn().id ? undefined : id))}
                        // A click (pressed and released on the row) unfolds the transcript at the turn, its start
                        // on this line.
                        onMouseDown={() => (pressed = turn().id)}
                        onMouseUp={() => {
                          if (pressed === turn().id) jump(turn())
                          pressed = undefined
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
                              return lit()
                            },
                          }}
                        >
                          <MapTurn sessionID={props.sessionID} turn={turn()} selected={lit()} />
                        </Slot>
                      </box>
                    )
                  }}
                </Match>
              </Switch>
            )}
          </For>
        </Show>
        <Show when={tail() > 0}>
          <box height={tail()} flexShrink={0} />
        </Show>
      </scrollbox>
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
