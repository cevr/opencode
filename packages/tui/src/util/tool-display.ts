export function canonicalToolName(name: string) {
  if (name === "bash") return "shell"
  if (name === "task") return "subagent"
  if (name === "apply_patch") return "patch"
  return name
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return value
}

export function primitiveInputSummary(input: Record<string, unknown>, omit: readonly string[] = []) {
  const entries = Object.entries(input).filter(([key, value]) => {
    if (omit.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (entries.length === 0) return ""
  return `[${entries.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`
}

export type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

export function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    if (!isRecord(call)) return []
    const tool = call.tool
    const status = call.status
    if (typeof tool !== "string" || (status !== "running" && status !== "completed" && status !== "error")) return []
    return [{ tool, status, input: isRecord(call.input) ? call.input : undefined }]
  })
}

export function executeCallSummary(call: ExecuteCall) {
  const args = primitiveInputSummary(call.input ?? {}).replace(/\s+/g, " ")
  return `${call.tool}${args ? ` ${args}` : ""}`
}

export function webSearchProviderName(provider: unknown) {
  if (typeof provider !== "string" || !provider) return ""
  if (provider === "opencode") return "OpenCode"
  return `${provider[0].toUpperCase()}${provider.slice(1)}`
}

export function webSearchProviderLabel(provider: unknown) {
  const name = webSearchProviderName(provider)
  return name ? `Web Search via ${name}` : "Web Search"
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "streaming") return {}
  if (!("metadata" in state) || !state.metadata || typeof state.metadata !== "object") return {}
  if (Array.isArray(state.metadata)) return {}
  return state.metadata as Record<string, unknown>
}

export function toolDisplayContent(state: SessionMessageAssistantTool["state"]) {
  if (state.status === "streaming" || state.status === "running") return []
  return state.content ?? []
}

/**
 * A shell call that acts on a handle rather than running a command: `{ action: "check", id }` checks it,
 * `{ action: "wait", id }` waits on it, `{ action: "kill", id }` stops it, `{ action: "list" }` lists the
 * session's shells. Its row's words. Older transcripts' flag forms (`{ id }`, `{ id, wait }`,
 * `{ id, kill: true }`, `{ list: true }`) read the same.
 */
export function shellActionSummary(input: Record<string, unknown>) {
  const action = input.action
  if (action === "run" || (action === undefined && typeof input.command === "string")) return undefined
  if (action === "list" || (action === undefined && input.list === true)) return "Listed shells"
  if (typeof input.id !== "string") return undefined
  if (action === "kill" || (action === undefined && input.kill === true)) return `Killed ${input.id}`
  if (action === "wait" || (action === undefined && input.wait !== undefined)) return `Waited on ${input.id}`
  return `Checked ${input.id}`
}

/**
 * The output text of a shell call: its content's text, less the handle's header line (`sh_… · exited 0 · 1.2 s`),
 * which a call that returns a handle (`metadata.id`) puts first as its own part.
 */
export function shellOutputText(state: SessionMessageAssistantTool["state"], metadata: Record<string, unknown>) {
  if (state.status === "streaming") return undefined
  const texts = toolDisplayContent(state).flatMap((content) =>
    content.type === "text" ? [content.text] : [content.name ?? content.uri],
  )
  return (typeof metadata.id === "string" && metadata.id.startsWith("sh_") ? texts.slice(1) : texts).join("\n")
}

export function nonEmptyToolContent<T>(content: ReadonlyArray<T> | undefined): [T, ...T[]] | undefined {
  if (!content) return undefined
  const [first, ...rest] = content
  return first === undefined ? undefined : [first, ...rest]
}
import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { isRecord } from "./record"
