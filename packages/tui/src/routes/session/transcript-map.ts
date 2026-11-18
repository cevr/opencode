export * as TranscriptMap from "./transcript-map"

import type { SessionOutlineEntry } from "@opencode/client"
import type { SessionEntry, SessionNode, SessionRow } from "./grouping/session"

/**
 * The transcript map: a session read as one line per turn (a prompt, an agent's run of steps, a notice) from its
 * outline, which carries each message's kind, time and the start of its text but never its body.
 */

export type TurnKind = "user" | "agent" | "notice"

export type Turn = {
  /** The message the transcript scrolls to: the prompt, the notice, or the agent run's first step. */
  readonly id: string
  readonly kind: TurnKind
  readonly time: number
  /** Who the line names: `you`, `agent`, or a notice's sender (`subagent`, `monitor`, `message`, …). */
  readonly who: string
  /** One line: a prompt's first line, a notice's description, an agent run's first sentence. */
  readonly gist: string
  /** An agent run's tool calls. */
  readonly tools: number
}

export type MapRow = { readonly type: "day"; readonly label: string } | { readonly type: "turn"; readonly turn: Turn }

const GIST = 200

const NOTICE_SOURCES: Record<string, string> = {
  subagent: "subagent",
  mail: "message",
  questions: "answer",
  shell: "shell",
}

/** Wake notices name their kind first (`monitor w1 matched · …`, `job j2 done`); others say `wake`. */
const WAKE_KINDS = new Set(["monitor", "wake", "job", "notice", "latch", "alarm"])

function firstLine(text: string) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.slice(0, GIST)
  }
  return ""
}

/** The first sentence of the first line, so an answer's gist reads as its opening claim. */
export function firstSentence(text: string) {
  const line = firstLine(text)
  const match = /^.*?[.!?](?=\s|$)/.exec(line)
  return (match ? match[0] : line).slice(0, GIST)
}

export function toolCount(tools: number) {
  if (tools === 0) return "(no reply)"
  return tools === 1 ? "1 tool call" : `${tools} tool calls`
}

function noticeWho(entry: SessionOutlineEntry) {
  if (entry.type === "system") return "system"
  if (entry.source === "wake") {
    const word = entry.text?.split(/\s/, 1)[0] ?? ""
    return WAKE_KINDS.has(word) ? word : "wake"
  }
  if (entry.source && NOTICE_SOURCES[entry.source]) return NOTICE_SOURCES[entry.source]!
  // Prime's own notices (queue checks, lands) carry no source but say what they are first.
  if (entry.text?.startsWith("Queue check")) return "queue"
  return "notice"
}

/** Builds the turns of a session's outline, oldest first. */
export function turns(entries: readonly SessionOutlineEntry[]): Turn[] {
  const result: Turn[] = []
  // The agent run still collecting steps, until an input or an idle marker ends it.
  let run: { index: number; text?: string; tools: number } | undefined
  const close = () => {
    if (!run) return
    const turn = result[run.index]!
    result[run.index] = {
      ...turn,
      gist: run.text ? firstSentence(run.text) : toolCount(run.tools),
      tools: run.tools,
    }
    run = undefined
  }
  for (const entry of entries) {
    if (entry.type === "assistant") {
      if (!run) {
        run = { index: result.length, tools: 0 }
        result.push({ id: entry.id, kind: "agent", time: entry.time, who: "agent", gist: "", tools: 0 })
      }
      run.tools += entry.tools ?? 0
      if (!run.text && entry.text?.trim()) run.text = entry.text
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
  const base = { id: entry.id, time: entry.time, tools: 0 }
  switch (entry.type) {
    case "user":
      return { ...base, kind: "user", who: "you", gist: firstLine(entry.text ?? "") || "(attachment)" }
    case "shell":
      return { ...base, kind: "user", who: "you", gist: `!${firstLine(entry.text ?? "")}` }
    case "skill":
      return { ...base, kind: "user", who: "you", gist: `/${entry.text ?? "skill"}` }
    // A synthetic message without a description is model-facing only; the transcript does not show it either.
    case "synthetic":
    case "system":
      if (!entry.text?.trim()) return undefined
      return { ...base, kind: "notice", who: noticeWho(entry), gist: firstLine(entry.text) }
    case "compaction":
      return { ...base, kind: "notice", who: "compaction", gist: "Compacted the conversation" }
    default:
      return undefined
  }
}

const pad = (value: number) => String(value).padStart(2, "0")

/** `14:05`, local time. */
export function clock(time: number) {
  const date = new Date(time)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `Tue Nov 17`, local date. */
export function day(time: number) {
  return new Date(time).toDateString().slice(0, 10)
}

/** The turns with a day separator above the first turn of each day. */
export function rows(list: readonly Turn[]): MapRow[] {
  const result: MapRow[] = []
  let current: string | undefined
  for (const turn of list) {
    const label = day(turn.time)
    if (label !== current) {
      current = label
      result.push({ type: "day", label })
    }
    result.push({ type: "turn", turn })
  }
  return result
}

/** What a filter matches a turn by: its time (`03:`, `14:05`), its day (`Nov 17`, `Tue`), who, and its gist. */
export function searchText(turn: Turn) {
  return `${clock(turn.time)} ${day(turn.time)} ${turn.who} ${turn.gist}`.toLowerCase()
}

function entryMessage(entry: SessionEntry) {
  if (entry.type === "part") return entry.ref.messageID
  if (entry.type === "message" || entry.type === "assistant-footer") return entry.messageID
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
