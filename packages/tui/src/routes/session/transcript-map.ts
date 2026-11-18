export * as TranscriptMap from "./transcript-map"

import type { SessionOutlineEntry } from "@opencode/client"
import type { SessionEntry, SessionNode, SessionRow } from "./grouping/session"

/**
 * The transcript map: a session read as one collapsed line per turn (a prompt, an agent's run of steps, a notice) from
 * its outline, which carries each message's kind, time, one-line summary and a step's counts but never its body.
 */

export type TurnKind = "user" | "agent" | "notice" | "compaction"

export type Turn = {
  /** The message the transcript scrolls to: the prompt, the notice, or the agent run's first step. */
  readonly id: string
  readonly kind: TurnKind
  /** When the turn reads as happening: a prompt or notice when sent, an agent run when its last step ended. */
  readonly time: number
  /** Who the line names: `you`, `agent`, or a notice's sender (`subagent`, `monitor`, `message`, …). */
  readonly who: string
  /** One line: a prompt's first line, a notice's title, the first sentence of an agent run's final text. */
  readonly gist: string
  /** An agent run's tool calls. */
  readonly tools: number
  /** An agent run's thoughts. */
  readonly thoughts: number
  /** A notice's sender as the server names it (`subagent`, `shell`, `mail`, `wake`, …). */
  readonly source?: string
}

/**
 * One line of the map: a day's dim label where the day changes, the blank line the transcript keeps above each
 * prompt, or a turn.
 */
export type MapRow =
  | { readonly type: "day"; readonly label: string }
  | { readonly type: "gap" }
  | { readonly type: "turn"; readonly turn: Turn }

const NOTICE_SOURCES: Record<string, string> = {
  subagent: "subagent",
  mail: "message",
  questions: "answer",
  shell: "shell",
}

/** Wake notices name their kind first (`monitor w1 matched · …`, `job j2 done`); others say `wake`. */
const WAKE_KINDS = new Set(["monitor", "wake", "job", "notice", "latch", "alarm"])

/** The work an agent run collapses to: `2 thoughts, 3 tools`, empty when it did none. */
export function work(turn: Pick<Turn, "thoughts" | "tools">) {
  const count = (value: number, noun: string) => (value > 0 ? [`${value} ${noun}${value === 1 ? "" : "s"}`] : [])
  return [...count(turn.thoughts, "thought"), ...count(turn.tools, "tool")].join(", ")
}

function noticeWho(entry: SessionOutlineEntry) {
  if (entry.type === "system") return "system"
  if (entry.source === "wake") {
    const word = entry.summary?.split(/\s/, 1)[0] ?? ""
    return WAKE_KINDS.has(word) ? word : "wake"
  }
  if (entry.source && NOTICE_SOURCES[entry.source]) return NOTICE_SOURCES[entry.source]!
  // Prime's own notices (queue checks, lands) carry no source but say what they are first.
  if (entry.summary?.startsWith("Queue check")) return "queue"
  return "notice"
}

/** Builds the turns of a session's outline, oldest first. */
export function turns(entries: readonly SessionOutlineEntry[]): Turn[] {
  const result: Turn[] = []
  // The agent run still collecting steps, until an input or an idle marker ends it.
  let run: { index: number; summary?: string; tools: number; thoughts: number; end: number } | undefined
  const close = () => {
    if (!run) return
    result[run.index] = {
      ...result[run.index]!,
      time: run.end,
      gist: run.summary ?? "",
      tools: run.tools,
      thoughts: run.thoughts,
    }
    run = undefined
  }
  for (const entry of entries) {
    if (entry.type === "assistant") {
      if (!run) {
        run = { index: result.length, tools: 0, thoughts: 0, end: entry.time }
        result.push({ id: entry.id, kind: "agent", time: entry.time, who: "agent", gist: "", tools: 0, thoughts: 0 })
      }
      run.tools += entry.tools ?? 0
      run.thoughts += entry.thoughts ?? 0
      run.end = entry.completed ?? entry.time
      // The run is named by its final text: the last step that wrote any.
      if (entry.summary) run.summary = entry.summary
      continue
    }
    if (entry.type === "idle") {
      close()
      continue
    }
    const turn = inputTurn(entry)
    if (!turn) continue
    close()
    result.push(turn)
  }
  close()
  return result
}

function inputTurn(entry: SessionOutlineEntry): Turn | undefined {
  const base = { id: entry.id, time: entry.time, tools: 0, thoughts: 0 }
  const summary = entry.summary ?? ""
  switch (entry.type) {
    case "user":
      return { ...base, kind: "user", who: "you", gist: summary || "(attachment)" }
    case "shell":
      return { ...base, kind: "user", who: "you", gist: `!${summary}` }
    case "skill":
      return { ...base, kind: "user", who: "you", gist: `/${summary || "skill"}` }
    // A notice without a title is model-facing only; the transcript does not show it either.
    case "synthetic":
    case "system":
      if (!summary) return undefined
      return { ...base, kind: "notice", who: noticeWho(entry), gist: summary, source: entry.source }
    case "compaction":
      return { ...base, kind: "compaction", who: "compaction", gist: "Compaction" }
    default:
      return undefined
  }
}

const pad = (value: number) => String(value).padStart(2, "0")

/** `14:05`, local time: what a filter also matches. */
export function clock24(time: number) {
  const date = new Date(time)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// Built once: a map of thousands of turns formats each of them.
const formats = {
  time: new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
  generic: new Intl.DateTimeFormat("en-US", { timeZoneName: "shortGeneric" }),
  short: new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }),
}

// The zone's name by its offset from UTC: a session's turns share one or two (daylight saving), so each is read once.
const zones = new Map<number, string>()

/** A zone's short name: the generic one where it is short (`ET`, `PT`), else the standard one (`UTC`, `GMT+1`). */
function zone(time: number) {
  const offset = new Date(time).getTimezoneOffset()
  const known = zones.get(offset)
  if (known !== undefined) return known
  const name = (format: Intl.DateTimeFormat) =>
    format.formatToParts(time).find((part) => part.type === "timeZoneName")?.value ?? ""
  const generic = name(formats.generic)
  const label = /^[A-Z]{1,4}$/.test(generic) ? generic : name(formats.short)
  zones.set(offset, label)
  return label
}

/** `12:02 PM ET`, local time, as the transcript writes a turn's end. */
export function clock(time: number) {
  // ICU puts a narrow no-break space before AM/PM; the row reads a plain one.
  return `${formats.time.format(time).replaceAll("\u202f", " ")} ${zone(time)}`
}

/** `Tue Nov 17`, local date. */
export function day(time: number) {
  return new Date(time).toDateString().slice(0, 10)
}

/**
 * The map's lines: the turns, a day label above the first turn of each day, and a blank line above each prompt that
 * follows other turns, so each exchange reads as a block the way the transcript spaces it.
 */
export function rows(list: readonly Turn[]): MapRow[] {
  const result: MapRow[] = []
  let current: string | undefined
  for (const turn of list) {
    const label = day(turn.time)
    if (label !== current) {
      if (result.length > 0) result.push({ type: "gap" })
      current = label
      result.push({ type: "day", label })
    } else if (turn.kind === "user" && result.length > 0) result.push({ type: "gap" })
    result.push({ type: "turn", turn })
  }
  return result
}

export type NoticeState = "finished" | "failed" | "cancelled"

/**
 * A worker's or shell's stop notice, as its title (`Implementor finished · fix csv`) says it: who, how it ended, and
 * its task. Other notices are not one.
 */
export function completion(turn: Pick<Turn, "kind" | "source" | "gist">) {
  if (turn.kind !== "notice" || (turn.source !== "subagent" && turn.source !== "shell")) return undefined
  const match = /^(.+?) (finished|failed|cancelled)(?: · (.*))?$/s.exec(turn.gist)
  if (!match) return undefined
  return { actor: match[1]!, state: match[2] as NoticeState, task: match[3] ?? "" }
}

/** What a filter matches a turn by: its time (`03:`, `14:05`, `2:05 PM`), its day (`Nov 17`, `Tue`), who, its gist. */
export function searchText(turn: Turn) {
  return `${clock24(turn.time)} ${clock(turn.time)} ${day(turn.time)} ${turn.who} ${turn.gist}`.toLowerCase()
}

function entryMessage(entry: SessionEntry) {
  if (entry.type === "part") return entry.ref.messageID
  if (entry.type === "message" || entry.type === "assistant-footer") return entry.messageID
}

/** The first message a transcript row shows (a group's first entry's), if it shows one. */
export function rowMessage(row: SessionRow | SessionNode): string | undefined {
  if (row.type === "group") {
    for (const child of row.children) {
      const found = rowMessage(child)
      if (found) return found
    }
    return undefined
  }
  if (row.type === "entry") return entryMessage(row.entry)
  return entryMessage(row) ?? (row.type === "turn-usage" ? row.messageIDs[0] : undefined)
}

/** Whether a transcript row shows any of a message: the message itself, one of its parts, or a group holding one. */
export function rowHoldsMessage(row: SessionRow | SessionNode, messageID: string): boolean {
  if (row.type === "group") return row.children.some((child) => rowHoldsMessage(child, messageID))
  if (row.type === "entry") return entryMessage(row.entry) === messageID
  return entryMessage(row) === messageID
}

/** Turns that hold every word of the query, in any order. */
export function filter(list: readonly Turn[], query: string, text = searchText) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return list
  // A day reads as two words (`Nov 17`); match the query whole first so the pair is not split across fields.
  const whole = query.trim().toLowerCase()
  return list.filter((turn) => {
    const haystack = text(turn)
    return haystack.includes(whole) || words.every((word) => haystack.includes(word))
  })
}
