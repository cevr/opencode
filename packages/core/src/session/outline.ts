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

/** What a message's summary is made from: the outline's read takes these columns, a client its loaded message. */
export type SummaryInput = {
  readonly type: string
  /** The text the summary is found in, at most {@link ExcerptLength} characters of it. */
  readonly text?: string | null
  readonly source?: string | null
  readonly agent?: string | null
  readonly state?: string | null
}

/** A message's one line by its type: see {@link Entry.summary}. */
export function summary(input: SummaryInput) {
  if (input.type === "assistant") return firstSentence(input.text)
  if (input.type === "synthetic") return noticeTitle({ ...input, description: input.text })
  if (input.type === "shell" || input.type === "skill") return firstLine(input.text, { verbatim: true })
  return firstLine(input.text)
}

/** One message as a transcript map reads it: never its body. */
export type Entry<Id extends string = string, Type extends string = string> = {
  readonly id: Id
  readonly type: Type
  readonly time: number
  /** When an assistant step completed. */
  readonly completed?: number
  /**
   * At most {@link SummaryLength} characters a reader knows the message by: a prompt's first line, a notice's title,
   * the first sentence of an assistant step's last text, a shell's command, a skill's name.
   */
  readonly summary?: string
  /** `metadata.source`, naming who sent a synthetic message (a subagent, a monitor, another session). */
  readonly source?: string
  /** An assistant step's tool calls. */
  readonly tools?: number
  /** An assistant step's thoughts: its reasoning parts with words in them. */
  readonly thoughts?: number
}

/** A message as a client holds it: the fields an {@link Entry} is made from, whatever its type. */
export type Message<Id extends string = string, Type extends string = string> = {
  readonly id: Id
  readonly type: Type
  readonly time: { readonly created: number; readonly completed?: number }
  readonly metadata?: { readonly [key: string]: unknown }
  readonly text?: string
  readonly description?: string
  readonly command?: string
  readonly name?: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

const excerpt = (text: string | undefined) => text?.slice(0, ExcerptLength)
const string = (value: unknown) => (typeof value === "string" ? value : undefined)
/** A thought the transcript shows has words in it: a redacted block alone renders nothing. */
const worded = (text: string | undefined) => (text ?? "").replaceAll("[REDACTED]", "").trim() !== ""

/** The text a message's summary is found in, as the outline's read takes it from the stored message. */
function textOf(message: Message) {
  switch (message.type) {
    case "assistant":
      return message.content?.findLast((part) => part.type === "text" && (part.text ?? "").trim() !== "")?.text
    case "user":
      return message.text
    case "synthetic":
      return message.description
    case "system":
      return message.description ?? message.text
    case "shell":
      return message.command
    case "skill":
      return message.name
  }
}

/**
 * The {@link Entry} of a message a client already holds, the same one the outline's read makes on the server, so a
 * map can fold the loaded messages without asking for them again.
 */
export function entry<Id extends string, Type extends string>(message: Message<Id, Type>): Entry<Id, Type> {
  const assistant = message.type === "assistant"
  const made = summary({
    type: message.type,
    text: excerpt(textOf(message)),
    source: string(message.metadata?.source),
    agent: string(message.metadata?.agent),
    state: string(message.metadata?.state),
  })
  const count = (type: string, keep: (text: string | undefined) => boolean = () => true) =>
    assistant ? (message.content?.filter((part) => part.type === type && keep(part.text)).length ?? 0) : 0
  const tools = count("tool")
  const thoughts = count("reasoning", worded)
  const source = string(message.metadata?.source)
  const completed = assistant ? message.time.completed : undefined
  return {
    id: message.id,
    type: message.type,
    time: message.time.created,
    ...(typeof completed === "number" ? { completed } : {}),
    ...(made ? { summary: made } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(tools ? { tools } : {}),
    ...(thoughts ? { thoughts } : {}),
  }
}
