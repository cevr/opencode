export * as SessionSynthetic from "./synthetic.js"

import { Effect } from "effect"
import type { Database } from "../database/database.js"
import { SessionAdmission } from "./admission.js"
import { NotFoundError, SyntheticConflictError } from "./error.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import type { SessionStore } from "./store.js"

export const make = (
  store: SessionStore.Interface,
  inbox: SessionInbox.Interface,
  wake: (id: SessionSchema.ID) => Effect.Effect<void>,
  db: Database.Interface["db"],
) =>
  Effect.fn("Session.synthetic")(function* (input: {
    sessionID: SessionSchema.ID
    id?: SessionMessage.ID
    text: string
    description?: string
    metadata?: Record<string, unknown>
    delivery?: SessionInbox.Delivery
    resume?: boolean
    /** Fork (synthetic-archived): who admits it, which decides an archived session's answer (SessionAdmission). */
    source?: SessionAdmission.Source
    /** Fork (synthetic-archived): told the ring's decision for the committed input (the restart sweep's wakes). */
    decided?: (decision: SessionAdmission.Decision) => Effect.Effect<void>
  }) {
    const sessionID = input.sessionID
    const session = yield* store.get(sessionID)
    if (!session) return yield* new NotFoundError({ sessionID })
    // Early refusal; the admitting transaction decides again, atomically with the write.
    const rule = SessionAdmission.rule(input.source)
    if (session.time.archived && rule === "refuse")
      return yield* Effect.die(new SessionAdmission.Refused(sessionID, "archived"))
    const id = input.id ?? SessionMessage.ID.create()
    const resume = input.resume !== false
    const decide = SessionAdmission.commit({ db, store, sessionID, inputID: id, rule })
    const admitted = yield* SessionAdmission.refused(
      store,
      sessionID,
      inbox.admit({
        id,
        sessionID,
        item: {
          type: "synthetic",
          delivery: input.delivery ?? "steer",
          payload: SessionInbox.SyntheticPayload.make({
            text: input.text,
            description: input.description,
            metadata: input.metadata,
          }),
        },
        // Decided inside the admitting transaction: refused (no row) or held.
        commit: decide,
      }),
    ).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () => new SyntheticConflictError({ sessionID, inputID: id })),
    )
    // Rung only now, for the committed row (a retry of the same ID included), in its own transaction under the same
    // rule: a rolled-back admission threw above and rings nothing; a held input rings nothing.
    if (resume || input.decided)
      yield* SessionAdmission.ring({
        db,
        store,
        sessionID,
        inputID: id,
        rule,
        wake: resume ? wake : undefined,
        decided: input.decided,
      })
    return admitted
  }, Effect.uninterruptible)
