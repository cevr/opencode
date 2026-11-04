// Pure helpers for the Prime look: what one transcript row says, without
// any rendering. Everything here reads the public message shapes only.
import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"

/** How much of each tool call the transcript shows; Ctrl+O cycles it. */
export type Detail = "overview" | "details" | "all"

export const details: readonly Detail[] = ["overview", "details", "all"]

export function nextDetail(current: Detail): Detail {
  return details[(details.indexOf(current) + 1) % details.length] ?? "overview"
}

export function detailHint(detail: Detail) {
  if (detail === "overview") return "Collapsed mode (Ctrl+O to expand)"
  if (detail === "details") return "Details mode (Ctrl+O to expand)"
  return "Expanded mode (Ctrl+O to collapse)"
}

// The host names text and reasoning parts by ordinal (`text:2`) and tool
// parts by call ID. A plugin has to know that scheme today; see the report's
// `data.session.part.get` gap.
export function findPart(message: SessionMessageInfo | undefined, partID: string) {
  if (message?.type !== "assistant") return
  const assistant = message as SessionMessageAssistant
  const tool = assistant.content.find((part) => part.type === "tool" && part.id === partID)
  if (tool) return tool as SessionMessageAssistantTool
  const match = /^(text|reasoning):(\d+)$/.exec(partID)
  if (!match) return
  return assistant.content.filter((part) => part.type === match[1])[Number(match[2])] as
    | SessionMessageAssistantText
    | SessionMessageAssistantReasoning
    | undefined
}

export type ToolStatus = "queued" | "running" | "done" | "failed"

export function toolStatus(part: SessionMessageAssistantTool): ToolStatus {
  if (part.state.status === "streaming") return "queued"
  if (part.state.status === "running") return "running"
  if (part.state.status === "error") return "failed"
  return "done"
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

export function toolInput(part: SessionMessageAssistantTool) {
  return typeof part.state.input === "string" ? {} : record(part.state.input)
}

export function toolMetadata(part: SessionMessageAssistantTool) {
  if (part.state.status === "streaming" || part.state.status === "running") return {}
  return record(part.state.metadata)
}

// The one input field that best stands for the call, as the row's preview
// and the source of the `↑` line count.
export function toolSource(tool: string, input: Record<string, unknown>) {
  if (tool === "shell") return text(input.command) ?? ""
  if (tool === "patch") return text(input.patchText) ?? ""
  if (tool === "read") return text(input.path) ?? text(input.filePath) ?? ""
  if (tool === "grep") return [text(input.pattern), text(input.path)].filter(Boolean).join(" in ")
  if (tool === "glob") return text(input.pattern) ?? ""
  if (tool === "subagent") return text(input.description) ?? text(input.prompt) ?? ""
  return Object.entries(input)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ")
}

export function toolPreview(tool: string, input: Record<string, unknown>) {
  if (tool === "patch") {
    const files = [...toolSource(tool, input).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(
      (match) => match[1],
    )
    if (files.length) return files.join(", ")
  }
  // One line: the first line of the source, with a trailing ellipsis when
  // more lines follow.
  const source = toolSource(tool, input).trim()
  const [first = "", ...rest] = source.split("\n")
  return rest.some((line) => line.trim()) ? `${first}…` : first
}

export function toolOutput(part: SessionMessageAssistantTool) {
  if (part.state.status === "streaming" || part.state.status === "running") return ""
  return (part.state.content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
}

function lines(value: string) {
  const trimmed = value.replace(/\n+$/, "")
  return trimmed ? trimmed.split("\n") : []
}

/** `↑` counts non-empty source lines; `↓` counts output lines, and is dropped for edits. */
export function lineCounts(tool: string, part: SessionMessageAssistantTool) {
  const up = lines(toolSource(tool, toolInput(part))).filter((line) => line.trim()).length
  if (tool === "patch" || part.state.status !== "completed") return { up, down: undefined }
  return { up, down: lines(toolOutput(part)).length }
}

export function countLabel(counts: { up: number; down?: number }) {
  return counts.down === undefined ? `↑ ${counts.up} lines` : `↑ ${counts.up} ↓ ${counts.down} lines`
}

export function duration(part: SessionMessageAssistantTool) {
  if (part.time.completed === undefined) return undefined
  const ms = Math.max(0, part.time.completed - (part.time.ran ?? part.time.created))
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`
}

/**
 * The short error name shown in red at the end of a failed row: the head of
 * the message ("File not found"), or the error type when there is none.
 */
export function errorName(part: SessionMessageAssistantTool) {
  if (part.state.status !== "error") return undefined
  const error = record(part.state.error)
  const head = (text(error.message) ?? "").split("\n")[0]!.split(":")[0]!.trim()
  if (head && head.length <= 40) return head
  return text(error.type)?.split(".").at(-1) ?? "error"
}

export type EditedFile = { path: string; additions: number; deletions: number; patch: string }

export function editedFiles(part: SessionMessageAssistantTool): EditedFile[] {
  const files = toolMetadata(part).files
  if (!Array.isArray(files)) return []
  return files.flatMap((value) => {
    const file = record(value)
    const path = text(file.relativePath) ?? text(file.file) ?? text(file.filePath)
    const patch = text(file.patch)
    if (!path || patch === undefined) return []
    return [
      {
        path,
        patch,
        additions: typeof file.additions === "number" ? file.additions : 0,
        deletions: typeof file.deletions === "number" ? file.deletions : 0,
      },
    ]
  })
}

export type DiffRow = { kind: "context" | "added" | "removed"; line: number; text: string } | { kind: "gap" }

/**
 * Unified-diff rows numbered the way Prime numbers them: a removed row by
 * its old line, every other row by its new line. `context` is how many
 * unchanged rows to keep around each change; Infinity keeps the whole hunk.
 */
export function diffRows(patch: string, context: number): DiffRow[] {
  const hunks: DiffRow[][] = []
  let oldLine = 0
  let newLine = 0
  let current: DiffRow[] | undefined
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      current = []
      hunks.push(current)
      continue
    }
    if (!current || raw.startsWith("\\")) continue
    if (raw.startsWith("-") && !raw.startsWith("---"))
      current.push({ kind: "removed", line: oldLine++, text: raw.slice(1) })
    else if (raw.startsWith("+") && !raw.startsWith("+++"))
      current.push({ kind: "added", line: newLine++, text: raw.slice(1) })
    else if (raw.startsWith(" ") || raw === "") {
      current.push({ kind: "context", line: newLine, text: raw.slice(1) })
      oldLine++
      newLine++
    }
  }
  const trimmed = hunks.map((rows) => {
    // Drop the trailing empty context row a final newline leaves behind.
    while (rows.at(-1)?.kind === "context" && (rows.at(-1) as { text: string }).text === "") rows.pop()
    if (context === Infinity) return rows
    const changed = rows.flatMap((row, index) => (row.kind === "context" ? [] : [index]))
    return rows.filter((_, index) => changed.some((at) => Math.abs(at - index) <= context))
  })
  return trimmed.flatMap((rows, index) => (index === 0 ? rows : [{ kind: "gap" } as DiffRow, ...rows]))
}
