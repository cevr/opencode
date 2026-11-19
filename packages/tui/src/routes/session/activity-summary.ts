import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"
import { canonicalToolName, executeCalls } from "../../util/tool-display"
import { visitEntries } from "./anchor-view"
import { instructionPaths, type PartRef, type SessionEntry, type SessionNode } from "./grouping/session"
import { reasoningContent } from "./message-parts"
import { resolvePart } from "./rows"

type Item = {
  message: SessionMessageAssistant
  part: SessionMessageAssistantReasoning | SessionMessageAssistantTool
}

/**
 * Summary for an activity group's subtree; permission-blocked tools are left out.
 * With nothing to count yet, a live thought labels it "Thinking…"; a code cell that has called nothing yet leaves it
 * unlabeled, so no row shows and the turn's own loader speaks for it.
 */
export function summarizeActivity(
  node: Extract<SessionNode, { type: "group" }>,
  message: (messageID: string) => SessionMessageInfo | undefined,
  pending: readonly PartRef[],
  closed: boolean,
) {
  const entries: SessionEntry[] = []
  visitEntries(node.children, (entry) => entries.push(entry))
  const items = entries.flatMap((entry) => {
    if (entry.type !== "part") return []
    if (pending.some((ref) => ref.messageID === entry.ref.messageID && ref.partID === entry.ref.partID)) return []
    const item = message(entry.ref.messageID)
    if (item?.type !== "assistant") return []
    const part = resolvePart(item, entry.ref.partID)
    return part?.type === "reasoning" || part?.type === "tool" ? [{ entry, message: item, part }] : []
  })
  const files = new Set(
    entries.flatMap((entry) => (entry.type === "message" ? instructionPaths(message(entry.messageID)) : [])),
  )
  const summary = activitySummary(items, files.size, closed)
  const thinking = items.find((item) => item.part.type === "reasoning" && isActive(item, closed))
  return { ...summary, label: summary.label || (thinking ? busyLabel(thinking.part) : "") }
}

/** Status for a running item, independent of its details, so it doesn't flicker as they arrive. */
export function busyLabel(part: Item["part"]) {
  if (part.type === "reasoning") return "Thinking…"
  const name = canonicalToolName(part.name)
  const noun = name === "shell" ? "command" : name === "execute" ? "code" : name
  return `${part.state.status === "streaming" ? "Preparing" : "Running"} ${noun}…`
}

/**
 * Low verbosity's activity summary, e.g. "3 commands, 1 edit, 2 thoughts, 4 reads".
 * The label counts calls, running ones too, so a command still running is named; a thought counts once finished,
 * and `active` reports anything still running.
 * A code cell (code-mode `execute`, Prime's `kernel`) counts its nested calls rather than itself.
 * Instructions count distinct loaded files, matching the instruction subgroup.
 * Once a later row closes the group, its thoughts count as finished, as in Medium.
 */
export function activitySummary(items: readonly Item[], instructions: number, closed = false) {
  const counts = { command: 0, edit: 0, thought: 0, read: 0, tool: 0, instruction: instructions }
  const count = (tool: string) => {
    const name = canonicalToolName(tool)
    if (name === "shell") counts.command++
    else if (name === "read") counts.read++
    else if (name === "edit" || name === "write" || name === "patch") counts.edit++
    else counts.tool++
  }
  items.forEach((item) => {
    if (item.part.type === "reasoning") {
      // Redacted-only reasoning renders nothing, so it isn't a visible thought.
      if (!isActive(item, closed) && reasoningContent(item.part)) counts.thought++
      return
    }
    const calls = cellCalls(item.part)
    if (calls) {
      calls.forEach((call) => count(call.tool))
      // With no nested calls to count, a finished cell counts as itself.
      if (calls.length === 0 && !isActive(item, closed)) counts.tool++
      return
    }
    count(item.part.name)
  })
  return {
    label: Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${count} ${name}${count === 1 ? "" : "s"}`)
      .join(", "),
    active: items.some((item) => isActive(item, closed)),
  }
}

/** A code cell's nested calls: code mode's `execute` keeps them in `toolCalls`, Prime's `kernel` in `operations`. */
function cellCalls(part: SessionMessageAssistantTool) {
  const name = canonicalToolName(part.name)
  if (name !== "execute" && name !== "kernel") return
  if (part.state.status === "streaming") return []
  return executeCalls(part.state.metadata?.[name === "execute" ? "toolCalls" : "operations"])
}

function isActive(item: Item, closed: boolean) {
  if (item.part.type === "reasoning")
    return !closed && item.part.time?.completed === undefined && item.message.time.completed === undefined
  return item.part.state.status === "streaming" || item.part.state.status === "running"
}
