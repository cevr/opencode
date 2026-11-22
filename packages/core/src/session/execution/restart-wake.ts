export * as RestartWake from "./restart-wake.js"

// Fork feature (shell-restart-wake): a background shell's end notice that a restart recovers wakes its idle owner, as
// the notice would have woken it had the server not stopped. Upstream admits it with `resume: false` and leaves the
// session waiting for its next prompt (664c8f0990); the owner chose the wake (2026-11-22). Shells only: every other
// recovered tool job keeps upstream's behavior.

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { duration } from "@opencode/util/duration"
import type { Database } from "../../database/database.js"
import { JobTable } from "../../job/sql.js"
import type { KV } from "../../kv.js"
import type { SessionExecution } from "../execution.js"
import { SessionInbox } from "../inbox.js"
import type { SessionMessage } from "../message.js"
import type { SessionSchema } from "../schema.js"
import type { SessionStore } from "../store.js"

/**
 * The durable mark of a recovered notice its owner is owed a wake for, keyed by the notice's ID. It is written before
 * the notice is admitted and outlives the wake: a later sweep clears it once the notice has left the inbox (a turn took
 * it) or its owner is owed nothing. A crash anywhere in between leaves the mark and the undelivered notice, so the next
 * sweep wakes the owner again: the wake is at least once, the notice is delivered once (its ID makes admission
 * idempotent), and a notice already delivered never wakes anyone.
 */
const MARK = "session.restart-wake:"

type DB = Database.Interface["db"]

/** When the job of a recovered notice started, read from its row before the row is completed. */
export const startedAt = Effect.fnUntraced(function* (db: DB, notificationID: SessionMessage.ID) {
  const row = yield* db
    .select({ started: JobTable.time_created })
    .from(JobTable)
    .where(eq(JobTable.notification_id, notificationID))
    .get()
    .pipe(Effect.orDie)
  return row?.started
})

export const mark = (kv: KV.Interface, notificationID: SessionMessage.ID, sessionID: SessionSchema.ID) =>
  kv.set(MARK + notificationID, sessionID)

/** The body of the notice of a background command the restart stopped. */
export const cancelled = (input: { readonly shellID: string; readonly startedAt?: number; readonly now: number }) =>
  [
    [
      input.shellID,
      "cancelled",
      ...(input.startedAt === undefined
        ? []
        : [`started ${duration(Math.max(0, input.now - input.startedAt))} before this notice`]),
    ].join(" · "),
    // Upstream's words first, so what reads them still matches.
    "Command cancelled because the server restarted (a reboot, a crash or a service stop), partway through; how long it ran before that is not known. Nothing was rerun: check what it left behind, and run it again if it is still needed.",
  ].join("\n")

/**
 * Wakes the owners of marked notices still in their inbox, through the same doorbell as any prompt
 * (`SessionExecution.wake`), and clears the marks of notices a turn already took or whose owner is owed nothing: gone,
 * archived, reverted, stopped, already running (its turn takes the notice as a steer item), or `skip` (claimed turns
 * this sweep did not resume, such as one past its restart budget).
 */
export const wakeOwed = Effect.fnUntraced(function* (input: {
  readonly kv: KV.Interface
  readonly db: DB
  readonly store: SessionStore.Interface
  readonly execution: SessionExecution.Interface
  readonly skip: ReadonlySet<SessionSchema.ID>
}) {
  let after: string | undefined
  do {
    const page = yield* input.kv.scan({ prefix: MARK, after })
    for (const entry of page.entries) {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- written by `mark` only
      const notificationID = entry.key.slice(MARK.length) as SessionMessage.ID
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- written by `mark` only
      const sessionID = entry.value as SessionSchema.ID
      const owed = yield* Effect.gen(function* () {
        if ((yield* SessionInbox.find(input.db, notificationID)) === undefined) return false
        const owner = yield* input.store.get(sessionID)
        if (!owner || owner.revert || owner.time.archived || input.skip.has(sessionID)) return false
        if (yield* input.execution.isActive(sessionID)) return false
        return !(yield* input.execution.stopped(sessionID))
      })
      if (owed) yield* input.execution.wake(sessionID)
      else yield* input.kv.remove(entry.key)
    }
    after = page.next
  } while (after !== undefined)
})
