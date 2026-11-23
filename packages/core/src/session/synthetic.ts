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
    /** Fork (synthetic-archived): told the admission's decision inside its transaction (the restart sweep's wakes). */
    decided?: (decision: SessionAdmission.Decision) => Effect.Effect<void>
  }) {
    const sessionID = input.sessionID
    const session = yield* store.get(sessionID)
    if (!session) return yield* new NotFoundError({ sessionID })
    // Early refusal; the admitting transaction decides again, atomically with the write.
    const keeps = SessionAdmission.keeps(input.source)
    if (session.time.archived && keeps) return yield* Effect.die(new SessionAdmission.Refused(sessionID, "archived"))
    const id = input.id ?? SessionMessage.ID.create()
    const resume = input.resume !== false
    // Whether this call's own admission decided (its transaction ran the commit hook), whatever it decided.
    let decided = false
    const decide = SessionAdmission.commit({
      db,
      store,
      sessionID,
      inputID: id,
      keeps,
      wake: resume ? wake : undefined,
      decided: input.decided,
    })
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
        // The wake is rung inside the admitting transaction: no archive commits between the two.
        commit: () => Effect.sync(() => void (decided = true)).pipe(Effect.andThen(decide())),
      }),
    ).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () => new SyntheticConflictError({ sessionID, inputID: id })),
    )
    // An input admitted before (a retry of the same ID) was not admitted by this call: wake for it as upstream does,
    // under the same rule, in its own transaction; a held input (archived when admitted) rings nothing.
    if (!decided && (resume || input.decided))
      yield* SessionAdmission.ring({
        db,
        store,
        sessionID,
        inputID: id,
        wake: resume ? wake : undefined,
        decided: input.decided,
      })
    return admitted
  }, Effect.uninterruptible)
