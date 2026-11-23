export * as SessionAdmission from "./admission.js"

// Fork feature (synthetic-archived): what something other than the user's own prompt may put into a session, and when
// it may start a turn there. Upstream admits a plugin's or a tool's message into any session that exists and wakes it,
// so a session the user archived between a plugin's check and its admit received the message and ran a turn after its
// archive (measured on real OpenCode: leaf-review-tools round 3, window-probe).
//
// The rule, one decision for every non-user source:
// - it is taken inside the write transaction that admits the input (a `Bus.publish` commit hook, under SQLite's write
//   lock), so an archive or a delete commits either before the admit (and is seen) or after it (and the input was
//   admitted while the session was live);
// - the wake is rung inside that same transaction: no archive can commit between the admit and the ring;
// - a deleted session refuses every source (typed NotFound);
// - an archived session refuses a source that keeps its input (typed ArchivedError, no row: the caller still holds it
//   and can give it again at the next prompt) and holds the input of one that does not (row admitted, no wake: the
//   next prompt's turn takes it once);
// - a reverted or stopped session admits and is not woken (upstream's rule for a revert, synthetic.ts's `revert`
//   check, and the fork's Session.stop rule), as before.
// Unarchiving wakes nothing: it publishes no work (session.ts `unarchive`).

import { and, eq, like, notExists, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database.js"
import { KVTable } from "../kv/sql.js"
import { NotFoundError } from "./error.js"
import type { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionInboxTable } from "./sql.js"
import type { SessionStore } from "./store.js"

/**
 * Every source other than the user's own prompt that admits input into a session, and whether it keeps its input
 * when refused. `keeps: true` → an archived session refuses it; `keeps: false` → an archived session holds it. Each
 * source names the files that admit through it; `test/session-admission-sources.test.ts` fails on an admission site
 * not named here.
 */
export const Sources = {
  plugin: {
    keeps: true,
    why: "a plugin's ctx.session.synthetic or ctx.session.prompt: the plugin holds its input and is told",
    sites: ["packages/core/src/plugin/host.ts"],
  },
  http: {
    keeps: true,
    why: "a client's POST /api/session/:id/synthetic: the client is told (409)",
    sites: ["packages/server/src/handlers/session.ts"],
  },
  shell: {
    keeps: false,
    why: "a shell's end notice (the shell tool's background command, the user's ! command): its output has no other home",
    sites: ["packages/core/src/tool/plugin/shell.ts", "packages/core/src/session/session.ts"],
  },
  job: {
    keeps: false,
    why: "a Code Mode script's background completion",
    sites: ["packages/core/src/session/execution.ts"],
  },
  media: {
    keeps: false,
    why: "an image or video generation's result",
    sites: ["packages/core/src/tool/plugin/image-generate.ts", "packages/core/src/tool/plugin/video-generate.ts"],
  },
  subagent: {
    keeps: false,
    why: "a subagent's report to its parent (live and at restart)",
    sites: [
      "packages/core/src/session/subagent-completion.ts",
      "packages/core/src/session/execution/subagent-report.ts",
    ],
  },
  restart: {
    keeps: false,
    why: "a notice the restart sweep recovers (a tool job the dead server left)",
    sites: ["packages/core/src/session/execution/restart.ts"],
  },
  background: {
    keeps: false,
    why: "the notice of the user's own request to background a session's blocking work",
    sites: ["packages/core/src/session.ts"],
  },
} as const

export type Source = keyof typeof Sources

/**
 * Whether `source` keeps its input. A caller naming no source (tests, and any new upstream caller until it is
 * classified, which the sources test catches) is held, never refused: upstream admitted it.
 */
export const keeps = (source: Source | undefined) => (source === undefined ? false : Sources[source].keeps)

/** A source that keeps its input was refused: the session is archived. Nothing was admitted. */
export class ArchivedError extends Schema.TaggedError<ArchivedError>()("Session.ArchivedError", {
  sessionID: SessionSchema.ID,
}) {}

/** The defect that aborts the admitting transaction; mapped back to a typed error by `refused`. */
export class Refused {
  readonly _tag = "SessionAdmission.Refused"
  constructor(
    readonly sessionID: SessionSchema.ID,
    readonly reason: "archived" | "deleted",
  ) {}
}

type DB = Database.Interface["db"]
type Store = Pick<SessionStore.Interface, "get">
type Wake = (sessionID: SessionSchema.ID) => Effect.Effect<void>

/**
 * What an admission decided: `live` (woken, unless the source asked for no wake or the session is stopped), `held`
 * (admitted into an archived session: never woken for it), `quiet` (a staged revert: admitted, not woken, as upstream).
 */
export type Decision = "live" | "held" | "quiet"

/**
 * The durable mark of a held input, written in its admitting transaction: whatever later rings for that input (a
 * retried admission, the restart sweep's owed wake) finds it and rings nothing, even once the session is unarchived.
 * Only a turn the user starts takes a held input. `sweep` drops the marks of inputs no longer in an inbox.
 */
const HELD = "session.held:"

/** What the session admits now; read inside the caller's transaction. */
const look = Effect.fnUntraced(function* (store: Store, sessionID: SessionSchema.ID) {
  const session = yield* store.get(sessionID)
  if (!session) return "deleted" as const
  if (session.time.archived) return "archived" as const
  // Upstream's rule (synthetic.ts `!(yield* get).revert`): a staged revert waits for its owner. The stop mark is the
  // `wake` function's to read (the fork's Session.stop: a notice admitted to a stopped session does not wake it).
  if (session.revert) return "quiet" as const
  return "live" as const
})

/** Whether `inputID` was admitted held (into an archived session). Reads inside the caller's transaction, if any. */
export const isHeld = Effect.fnUntraced(function* (db: DB, inputID: SessionMessage.ID) {
  const row = yield* db
    .select({ key: KVTable.key })
    .from(KVTable)
    .where(eq(KVTable.key, HELD + inputID))
    .get()
  return row !== undefined
}, Effect.orDie)

/**
 * The commit hook of a non-user admission (`Bus.PublishOptions.commit`): runs inside the InboxEnqueued transaction,
 * after its row is written. Refuses (a defect: the transaction rolls back, no row stays), or decides and rings `wake`
 * there. A wake rung for a transaction that then rolls back starts an execution that finds no input: no model call.
 */
export const commit =
  (input: {
    readonly db: DB
    readonly store: Store
    readonly sessionID: SessionSchema.ID
    readonly inputID: SessionMessage.ID
    /** Whether the source keeps its input (Sources[source].keeps): refused, not held, by an archived session. */
    readonly keeps: boolean
    /** Rung when the session is live; it checks the stop mark itself. Absent: admit without a wake. */
    readonly wake?: Wake
    /** Told the decision, inside the transaction (the restart sweep defers its wakes by it). */
    readonly decided?: (decision: Decision) => Effect.Effect<void>
  }) =>
  () =>
    Effect.gen(function* () {
      const state = yield* look(input.store, input.sessionID)
      if (state === "deleted") return yield* Effect.die(new Refused(input.sessionID, "deleted"))
      if (state === "archived" && input.keeps) return yield* Effect.die(new Refused(input.sessionID, "archived"))
      const decision: Decision = state === "archived" ? "held" : state
      if (decision === "held")
        yield* input.db
          .insert(KVTable)
          .values({ key: HELD + input.inputID, value: input.sessionID })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      if (decision === "live" && input.wake) yield* input.wake(input.sessionID)
      if (input.decided) yield* input.decided(decision)
    })

/**
 * The same decision for a wake with no admission of its own (an input admitted before, a report, a restart's owed
 * wake): in its own write transaction, so an archive commits before it (no wake) or after the ring. Given `inputID`,
 * a held input rings nothing.
 */
export const ring = (input: {
  readonly db: DB
  readonly store: Store
  readonly sessionID: SessionSchema.ID
  readonly wake?: Wake
  readonly inputID?: SessionMessage.ID
  readonly decided?: (decision: Decision) => Effect.Effect<void>
}) =>
  input.db
    .transaction(
      () =>
        Effect.gen(function* () {
          const state =
            input.inputID !== undefined && (yield* isHeld(input.db, input.inputID))
              ? "held"
              : yield* look(input.store, input.sessionID)
          if (state === "deleted") return
          const decision: Decision = state === "archived" ? "held" : state
          if (decision === "live" && input.wake) yield* input.wake(input.sessionID)
          if (input.decided) yield* input.decided(decision)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)

/** Drops the held marks of inputs no longer in any inbox (a user's turn took them, or the session is gone). */
export const sweep = (db: DB) =>
  db
    .delete(KVTable)
    .where(
      and(
        like(KVTable.key, `${HELD}%`),
        notExists(
          db
            .select({ id: SessionInboxTable.id })
            .from(SessionInboxTable)
            .where(eq(sql`${HELD} || ${SessionInboxTable.id}`, KVTable.key)),
        ),
      ),
    )
    .run()
    .pipe(Effect.orDie, Effect.asVoid)

/**
 * Maps a delete that refused an admission (the refusal, or the foreign-key defect of a delete racing it) to the
 * session's typed NotFoundError. An archive's refusal stays the `Refused` defect, so the error types of the session's
 * operations stay upstream's: only a source that keeps its input can meet it, and its caller maps it (`typed`).
 */
export const refused = <A, E, R>(store: Store, sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchDefect((defect): Effect.Effect<never, NotFoundError> => {
      if (defect instanceof Refused)
        return defect.reason === "deleted" ? Effect.fail(new NotFoundError({ sessionID })) : Effect.die(defect)
      return store
        .get(sessionID)
        .pipe(
          Effect.flatMap((session) =>
            session === undefined ? Effect.fail(new NotFoundError({ sessionID })) : Effect.die(defect),
          ),
        )
    }),
  )

/** The archive refusal, made a typed error for a caller that keeps its input (the plugin host, the HTTP route). */
export const typed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchDefect((defect) =>
      defect instanceof Refused && defect.reason === "archived"
        ? Effect.fail(new ArchivedError({ sessionID: defect.sessionID }))
        : Effect.die(defect),
    ),
  )
