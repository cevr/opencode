export * as SessionBackground from "./background.js"

import type { Kind, Status } from "@opencode/schema/job"
import { Effect } from "effect"
import type { Job } from "../job.js"
import type { SessionSchema } from "./schema.js"

export type Lookup = {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<{ readonly parentID?: SessionSchema.ID } | undefined>
}

export type ListFilter = {
  readonly sessionID?: SessionSchema.ID
  readonly kind?: Kind
  readonly status?: Status
  readonly descendants?: boolean
}

/**
 * Background jobs still running for a Session or any of its descendants. A child's own
 * background shell counts even after the child reported to its parent: its notice wakes
 * the child again, so the child's work is not finished.
 */
export const outstanding = Effect.fnUntraced(function* (
  jobs: Pick<Job.Interface, "runningBackground">,
  store: Lookup,
  sessionID: SessionSchema.ID,
) {
  const parents = new Map<SessionSchema.ID, SessionSchema.ID | null>()
  const owned = yield* Effect.filter(yield* jobs.runningBackground, (recovery) =>
    descends(store, parents, recovery.kind === "subagent" ? recovery.parentSessionID : recovery.sessionID, sessionID),
  )
  return owned.map((recovery) => {
    if (recovery.kind === "shell")
      return {
        kind: "shell" as const,
        sessionID: recovery.sessionID,
        shellID: recovery.shellID,
        command: recovery.command,
      }
    if (recovery.kind === "image")
      return { kind: "image" as const, sessionID: recovery.sessionID, path: recovery.path, model: recovery.model }
    return {
      kind: "subagent" as const,
      sessionID: recovery.parentSessionID,
      childSessionID: recovery.childSessionID,
      agent: recovery.agent,
      description: recovery.description,
    }
  })
})

/**
 * Waits until nothing `sessionID` launched in the background will wake it again: every
 * notice it owns is admitted and the turn each one wakes has gone idle. A notice owned by a
 * descendant wakes that descendant, not this Session, so it is not waited on here.
 */
export const awaitQuiet = Effect.fnUntraced(function* <E>(
  jobs: Pick<Job.Interface, "undelivered" | "awaitDelivered">,
  awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void, E>,
  sessionID: SessionSchema.ID,
) {
  while (true) {
    const owned = (yield* jobs.undelivered).filter(
      (notice) =>
        (notice.recovery.kind === "subagent" ? notice.recovery.parentSessionID : notice.recovery.sessionID) ===
        sessionID,
    )
    if (owned.length === 0) return
    yield* Effect.forEach(owned, (notice) => jobs.awaitDelivered(notice.notificationID), {
      concurrency: "unbounded",
      discard: true,
    })
    // Admission rings the owner's doorbell before it is acknowledged, so the woken turn is already active.
    yield* awaitIdle(sessionID)
  }
})

/** Active and unconsumed background jobs matching the requested Session, kind, status, and descendant scope. */
export const list = Effect.fn("SessionBackground.list")(function* (
  jobs: Pick<Job.Interface, "backgroundJobs">,
  store: Lookup,
  filter: ListFilter = {},
) {
  const items = (yield* jobs.backgroundJobs).filter(
    (item) =>
      (filter.kind === undefined || item.kind === filter.kind) &&
      (filter.status === undefined || item.status === filter.status),
  )
  if (filter.sessionID === undefined) return items
  const sessionID = filter.sessionID
  if (!filter.descendants) return items.filter((item) => item.sessionID === sessionID)
  const parents = new Map<SessionSchema.ID, SessionSchema.ID | null>()
  return yield* Effect.filter(items, (item) => descends(store, parents, item.sessionID, sessionID))
})

const descends = Effect.fnUntraced(function* (
  store: Lookup,
  parents: Map<SessionSchema.ID, SessionSchema.ID | null>,
  from: SessionSchema.ID,
  ancestor: SessionSchema.ID,
) {
  const seen = new Set<SessionSchema.ID>()
  let current: SessionSchema.ID | undefined = from
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    const cached = parents.get(current)
    if (cached !== undefined) {
      current = cached ?? undefined
      continue
    }
    const parentID = (yield* store.get(current))?.parentID
    parents.set(current, parentID ?? null)
    current = parentID
  }
  return false
})
