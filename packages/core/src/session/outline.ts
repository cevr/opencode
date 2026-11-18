export * as SessionOutline from "./outline.js"

/**
 * The one line a transcript map shows for a message, made from the start of its text: never more than
 * {@link SummaryLength} characters, so a whole session's outline stays a small fraction of its messages.
 */

/** Characters of a summary. */
export const SummaryLength = 120

/** Characters of a message's text the outline's read takes to find its summary in. */
export const ExcerptLength = 480

const cap = (text: string) => (text.length <= SummaryLength ? text : `${text.slice(0, SummaryLength - 1)}…`)

/** Markdown's marks around words (`**bold**`, `` `code` ``) and a line's lead (`# `, `- `, `> `), dropped. */
const plain = (line: string) =>
  line
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim()

/** The first line with words in it, without its markdown marks unless `verbatim` (a command). */
export function firstLine(text: string | null | undefined, options?: { readonly verbatim?: boolean }) {
  for (const line of (text ?? "").split("\n")) {
    const words = options?.verbatim ? line.trim() : plain(line)
    if (words) return cap(words)
  }
  return ""
}

/** The first sentence of the first line: it ends at a stop followed by a space or the line's end. */
export function firstSentence(text: string | null | undefined) {
  const line = firstLine(text)
  const match = /^.*?[.!?](?=\s|$)/.exec(line)
  return match ? match[0] : line
}

/**
 * A notice's title as the transcript heads it: a worker's or shell's stop notice reads `<Actor> <finished|failed|
 * cancelled> · <task>`, any other its description's first line.
 */
export function noticeTitle(input: {
  readonly description?: string | null
  readonly source?: string | null
  readonly agent?: string | null
  readonly state?: string | null
}) {
  const task = firstLine(input.description)
  if (input.source !== "subagent" && input.source !== "shell") return task
  const actor = input.source === "shell" ? "Shell" : titlecase(input.agent || "subagent")
  const status =
    input.state === "error" ? "failed" : !input.state || input.state === "completed" ? "finished" : input.state
  return cap(task ? `${actor} ${status} · ${task}` : `${actor} ${status}`)
}

const titlecase = (text: string) => text.replace(/\b\w/g, (letter) => letter.toUpperCase())
