export * as SessionBackground from "./background.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { SessionSchema } from "./schema.js"
import type { SessionStore } from "./store.js"

/**
 * Background jobs still running for a Session or any of its descendants. A child's own
 * background shell counts even after the child reported to its parent: its notice wakes
 * the child again, so the child's work is not finished.
 */
export const outstanding = Effect.fnUntraced(function* (
  jobs: Pick<Job.Interface, "runningBackground">,
  store: Pick<SessionStore.Interface, "get">,
  sessionID: SessionSchema.ID,
) {
  const owned = yield* Effect.filter(yield* jobs.runningBackground, (recovery) =>
    descends(store, recovery.kind === "subagent" ? recovery.parentSessionID : recovery.sessionID, sessionID),
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

const descends = Effect.fnUntraced(function* (
  store: Pick<SessionStore.Interface, "get">,
  from: SessionSchema.ID,
  ancestor: SessionSchema.ID,
) {
  const seen = new Set<SessionSchema.ID>()
  let current: SessionSchema.ID | undefined = from
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    current = (yield* store.get(current))?.parentID
  }
  return false
})
