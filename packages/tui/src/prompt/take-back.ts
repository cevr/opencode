import type { ProjectedPrompt } from "./codec"
import { appendPrompt, emptyPrompt, type PromptInfo } from "./history"
import type { WidthMethod } from "@opentui/core"

/** A pending inbox item, as the take-back reads it. */
export type PendingItem = { readonly id: string; readonly type: string; readonly payload?: unknown }

/** What the take-back runs on: the session's pending items, the prompt reader, the inbox cancel and the composer. */
export type TakeBackHost = {
  readonly pending: (sessionID: string) => ReadonlyArray<PendingItem>
  /** Reads a prompt back for the composer, its images as bytes; rejects when it cannot. */
  readonly restore: (prompt: ProjectedPrompt) => Promise<PromptInfo>
  /** Cancels a pending item; resolves whether the server cancelled it. */
  readonly cancel: (sessionID: string, inboxID: string) => Promise<boolean>
  /** Appends a prompt after the session's composer (or stashed draft), `separator` between. */
  readonly append: (sessionID: string, prompt: PromptInfo, separator: string) => void
  readonly widthMethod: WidthMethod
}

/**
 * Takes pending user prompts back out of a session's inbox into its composer: each is read back before its cancel
 * (a cancel releases the blobs nothing else references), then cancelled, and the cancelled ones are appended in
 * `inboxIDs` order, joined by `separator`. One the server did not cancel was delivered meanwhile, or stays pending:
 * it is left, never put in the composer, so no prompt is in two places.
 */
export async function takeBack(
  host: TakeBackHost,
  input: { readonly sessionID: string; readonly inboxIDs: readonly string[]; readonly separator?: string },
) {
  const separator = input.separator ?? "\n\n"
  const pending = new Map(
    host.pending(input.sessionID).flatMap((item) => (item.type === "user" ? [[item.id, item] as const] : [])),
  )
  const read = await Promise.all(
    input.inboxIDs.map(async (id) => {
      const item = pending.get(id)
      if (!item) return undefined
      return host.restore(item.payload as ProjectedPrompt).then(
        (prompt) => ({ id, prompt }),
        () => undefined,
      )
    }),
  )
  const cancelled = await Promise.all(
    read.map((entry) => (entry ? host.cancel(input.sessionID, entry.id) : Promise.resolve(false))),
  )
  const back = read.flatMap((entry, index) => (entry && cancelled[index] ? [entry] : []))
  if (back.length > 0)
    host.append(
      input.sessionID,
      back.reduce((merged, entry) => appendPrompt(merged, entry.prompt, host.widthMethod, separator), emptyPrompt()),
      separator,
    )
  const taken = back.map((entry) => entry.id)
  return { taken, left: input.inboxIDs.filter((id) => !taken.includes(id)) }
}
