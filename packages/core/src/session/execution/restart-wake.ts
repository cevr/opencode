export * as RestartWake from "./restart-wake.js"

// Fork feature (shell-restart-wake): a background shell's end notice that a restart recovers wakes its idle owner, as
// the notice would have woken it had the server not stopped. Upstream admits it with `resume: false` and leaves the
// session waiting for its next prompt (664c8f0990); the owner chose the wake (2026-11-22). Shells only: every other
// recovered tool job keeps upstream's behavior.

import { eq } from "drizzle-orm"
import { Clock, Effect, type Scope } from "effect"
import { duration } from "@opencode/util/duration"
import type { Database } from "../../database/database.js"
import type { Job } from "../../job.js"
import { JobTable } from "../../job/sql.js"
import type { KV } from "../../kv.js"
import { ShellResult } from "../../shell/result.js"
import type { SessionExecution } from "../execution.js"
import { SessionInbox } from "../inbox.js"
import type { SessionMessage } from "../message.js"
import type { SessionSchema } from "../schema.js"
import type { SessionStore } from "../store.js"

/**
 * The durable mark of a recovered notice its owner is owed a wake for, keyed by the notice's ID. It is written before
 * the notice is admitted and outlives the wake: it is cleared once the notice is seen gone from the inbox (a turn took
 * it) or its owner is owed nothing. A crash anywhere in between leaves the mark and the undelivered notice, so the next
 * sweep wakes the owner again: the wake is at least once, the notice is delivered once (its ID makes admission
 * idempotent), and a notice already delivered never wakes anyone.
 */
const MARK = "session.restart-wake:"

type DB = Database.Interface["db"]

/**
 * For a shell job the restart recovers with no command left to watch: marks its notice as owed a wake (a cancel or a
 * stop is owed none), and gives the notice of a command the restart stopped, or undefined for upstream's own notice
 * of one that ended before it.
 */
export const recover = Effect.fnUntraced(function* (
  kv: KV.Interface,
  db: DB,
  background: Job.Background,
  recovery: Extract<Job.Recovery, { kind: "shell" }>,
) {
  if (background.status === "cancelled") return undefined
  // Read before the row is completed: when the command started.
  const row = yield* db
    .select({ started: JobTable.time_created })
    .from(JobTable)
    .where(eq(JobTable.notification_id, background.notificationID))
    .get()
    .pipe(Effect.orDie)
  const now = yield* Clock.currentTimeMillis
  yield* kv.set(MARK + background.notificationID, recovery.sessionID)
  if (background.status !== "running") return undefined
  return {
    description: recovery.command,
    ...ShellResult.notification({
      jobID: background.id,
      shellID: recovery.shellID,
      command: recovery.command,
      state: "cancelled",
      text: cancelled({ shellID: recovery.shellID, startedAt: row?.started, now }),
    }),
  }
})

/** The body of the notice of a background command the restart stopped. */
const cancelled = (input: { readonly shellID: string; readonly startedAt?: number; readonly now: number }) =>
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

type Owed = {
  readonly kv: KV.Interface
  readonly db: DB
  readonly store: SessionStore.Interface
  readonly execution: SessionExecution.Interface
}

/**
 * Whether a marked notice is still owed a wake: it is still in its owner's inbox (no turn took it) and the owner is
 * there to be woken (not gone, archived, reverted or stopped). An archived owner's mark is retired for good: it is
 * not woken now, nor at a later boot, nor when unarchived; the notice stays queued for its next turn.
 */
const owed = Effect.fnUntraced(function* (input: Owed, notificationID: SessionMessage.ID, sessionID: SessionSchema.ID) {
  if ((yield* SessionInbox.find(input.db, notificationID)) === undefined) return false
  const owner = yield* input.store.get(sessionID)
  if (!owner || owner.revert || owner.time.archived) return false
  return !(yield* input.execution.stopped(sessionID))
})

/** Wakes for one notice, the first included, this many times at most; past that the mark waits for the next boot. */
const ATTEMPTS = 3

/**
 * Follows one owed notice until it is delivered or owed nothing, then clears its mark. Each time the owner goes idle
 * with the notice still in its inbox it is woken: the turn it was busy with may have passed its last inbox check, and
 * the user may interrupt the turn a wake started before its check. A wake rung here finds the
 * owner idle and starts its own turn, so it never doubles a model call; a turn that took the notice leaves nothing to
 * wake for.
 */
const follow = Effect.fnUntraced(function* (
  input: Owed,
  key: string,
  notificationID: SessionMessage.ID,
  sessionID: SessionSchema.ID,
  woken: number,
) {
  let attempts = woken
  while (true) {
    yield* input.execution.awaitIdle(sessionID)
    if (!(yield* owed(input, notificationID, sessionID))) return yield* input.kv.remove(key)
    // Work landed between its idle and this look: wait for that period too.
    if (yield* input.execution.isActive(sessionID)) continue
    if (attempts >= ATTEMPTS) return
    attempts++
    yield* input.execution.wake(sessionID)
  }
})

/**
 * Wakes the owners of marked notices still in their inbox, through the same doorbell as any prompt
 * (`SessionExecution.wake`), and clears the marks of notices a turn already took or whose owner is owed nothing: gone,
 * archived, reverted, stopped, or `skip` (claimed at boot: resumed after the notice was admitted, so its first drain
 * takes it, or past its restart budget).
 *
 * An idle owner is woken now. An owner busy now (work the new server gave it while the sweep ran) is not taken as
 * proof of delivery, since its turn may be past its last inbox check: each owed notice is followed (in `scope`) and its
 * owner woken once it is idle with the notice still undelivered. Its wake is not rung into the busy period: a drain
 * that coalesced wake would add after the period's work could run after an archive or a stop landing meanwhile, and an
 * interrupt of the period drops it anyway.
 */
export const wakeOwed = Effect.fnUntraced(function* (
  input: Owed & { readonly skip: ReadonlySet<SessionSchema.ID>; readonly scope: Scope.Scope },
) {
  let after: string | undefined
  do {
    const page = yield* input.kv.scan({ prefix: MARK, after })
    for (const entry of page.entries) {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- written by `recover` only
      const notificationID = entry.key.slice(MARK.length) as SessionMessage.ID
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- written by `recover` only
      const sessionID = entry.value as SessionSchema.ID
      if (input.skip.has(sessionID) || !(yield* owed(input, notificationID, sessionID))) {
        yield* input.kv.remove(entry.key)
        continue
      }
      const idle = !(yield* input.execution.isActive(sessionID))
      if (idle) yield* input.execution.wake(sessionID)
      yield* follow(input, entry.key, notificationID, sessionID, idle ? 1 : 0).pipe(
        Effect.ignoreCause,
        Effect.forkIn(input.scope),
      )
    }
    after = page.next
  } while (after !== undefined)
})
