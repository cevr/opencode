export * as SessionStepRoute from "./step-route.js"

import { eq, inArray } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import type { Database } from "../database/database.js"
import { KVTable } from "../kv/sql.js"
import { SessionMessage } from "./message.js"

/**
 * The durable routing state of a Session's unfinished runner Step, so a restart continues that Step rather than a
 * new one. It lives exactly as long as the execution claim: the runner writes it before each attempt and at each
 * hold, clears it when the Step completes, and `SessionStore.release` deletes it with the claim, in the terminal
 * event's transaction. A shutdown keeps both, so the next server routes the same Step with the same history.
 */
export const Record = Schema.Struct({
  /** What the Step routes with next: its id, the next attempt, and the previous attempt (a possible send pins it). */
  next: Schema.Struct({
    id: Schema.String,
    attempt: Schema.Number,
    previous: Schema.Struct({ model: Model.Ref, sent: Schema.Boolean }).pipe(Schema.optional),
  }),
  /** The assistant message the Step writes to. A held Step's is still empty, so it is reused. */
  message: SessionMessage.ID,
  /** Holds shown so far, numbering the Step's retry state. */
  holds: Schema.Number,
  /** The Step waits, sending nothing, until `until`, then routes `next`. */
  hold: Schema.Struct({
    until: Schema.Number,
    reason: Schema.String,
    model: Model.Ref,
    agent: Agent.ID,
  }).pipe(Schema.optional),
})
export type Record = typeof Record.Type

const PREFIX = "session.step-route:"
export const key = (sessionID: string) => PREFIX + sessionID

type DB = Database.Interface["db"]

const decode = Schema.decodeUnknownOption(Record)

export const read = Effect.fnUntraced(function* (db: DB, sessionID: string) {
  const row = yield* db
    .select({ value: KVTable.value })
    .from(KVTable)
    .where(eq(KVTable.key, key(sessionID)))
    .get()
    .pipe(Effect.orDie)
  // A record this version cannot read is no Step to continue: the turn resumes as a new Step.
  return row ? Option.getOrUndefined(decode(row.value)) : undefined
})

export const write = Effect.fnUntraced(function* (db: DB, sessionID: string, record: Record) {
  const value = Schema.encodeSync(Record)(record)
  yield* db
    .insert(KVTable)
    .values({ key: key(sessionID), value })
    .onConflictDoUpdate({ target: KVTable.key, set: { value, time_updated: Date.now() } })
    .run()
    .pipe(Effect.orDie)
})

export const clear = (db: DB, sessionIDs: ReadonlyArray<string>) =>
  sessionIDs.length === 0
    ? Effect.void
    : db
        .delete(KVTable)
        .where(inArray(KVTable.key, sessionIDs.map(key)))
        .run()
        .pipe(Effect.orDie, Effect.asVoid)
