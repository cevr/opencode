// Fork feature (synthetic-archived): the edges of deciding an admission and its wake in one transaction
// (session/admission.ts), on the real Session, coordinator, inbox and KV, with a drain that records what it takes.
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { Database } from "@opencode/core/database/database"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionAdmission } from "@opencode/core/session/admission"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { current, it } from "./fixture/admission-model"

const seed = Effect.fnUntraced(function* (id: string) {
  const { db } = yield* Database.Service
  const sessionID = Session.ID.make(id)
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: id,
      directory: "/project",
      title: id,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return sessionID
})

/** Drains record the inputs they take; returns the record. */
const recording = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const inbox = yield* SessionInbox.Service
  const drains: { sessionID: Session.ID; took: string[] }[] = []
  current.drain = (sessionID) =>
    Effect.gen(function* () {
      const before = (yield* SessionInbox.list(db, sessionID)).map((item) => item.id)
      while (((yield* inbox.promote(sessionID, "input")) ?? 0) > 0);
      const after = new Set((yield* SessionInbox.list(db, sessionID)).map((item) => item.id))
      drains.push({ sessionID, took: before.filter((id) => !after.has(id)) })
    }).pipe(Effect.orDie)
  return drains
})

describe("an HTTP client's message to an archived session (ACP's turn context)", () => {
  // As ACP's turn sends it (cli/src/acp/turn.ts submitSynthetic) through the route (source `http`).
  const context = (sessionID: Session.ID, id: SessionMessage.ID) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      let decision: SessionAdmission.Decision | undefined
      yield* sessions.synthetic({
        sessionID,
        id,
        text: "ACP embedded context",
        delivery: "steer",
        resume: false,
        source: "http",
        decided: (value) => Effect.sync(() => void (decision = value)),
      })
      return decision
    })

  it.live("context then the user's prompt: one turn, started by the prompt, taking the context once", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const execution = yield* SessionExecution.Service
      const drains = yield* recording
      const sessionID = yield* seed("ses_acp_prompt")
      yield* sessions.archive(sessionID)
      const contextID = SessionMessage.ID.create()
      expect(yield* context(sessionID, contextID)).toBe("held")
      yield* Effect.sleep(10)
      expect(drains).toEqual([])
      // The user's prompt, as ACP sends it next: admitted with no source (the user's own, upstream's admission, as
      // Session.prompt's is) and its turn started; Session.prompt itself needs the plugin graph this harness omits.
      const promptID = SessionMessage.ID.create()
      yield* sessions.synthetic({ sessionID, id: promptID, text: "the user's prompt", resume: false })
      yield* execution.resume(sessionID).pipe(Effect.ignore)
      yield* execution.awaitIdle(sessionID)
      const turns = drains.filter((drain) => drain.took.length > 0)
      expect(turns).toEqual([{ sessionID, took: [contextID, promptID] }])
      current.drain = () => Effect.void
    }),
  )

  it.live("context with no prompt after it, then unarchive: no turn, the row waits", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const execution = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      const drains = yield* recording
      const sessionID = yield* seed("ses_acp_alone")
      yield* sessions.archive(sessionID)
      const contextID = SessionMessage.ID.create()
      expect(yield* context(sessionID, contextID)).toBe("held")
      // The generic route's default (`resume` omitted) holds it too: no wake.
      const plainID = SessionMessage.ID.create()
      yield* sessions.synthetic({ sessionID, id: plainID, text: "a script's note", source: "http" })
      yield* sessions.unarchive(sessionID)
      yield* Effect.sleep(20)
      yield* execution.awaitIdle(sessionID)
      expect(drains).toEqual([])
      expect((yield* SessionInbox.list(db, sessionID)).map((item) => item.id)).toEqual([contextID, plainID])
      current.drain = () => Effect.void
    }),
  )
})

describe("SessionAdmission's transaction", () => {
  it.live("an admission whose transaction rolls back rings nothing: no turn, no marker, no row", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const execution = yield* SessionExecution.Service
      const store = yield* SessionStore.Service
      const { db } = yield* Database.Service
      const drains = yield* recording
      const sessionID = yield* seed("ses_rollback")
      const inputID = SessionMessage.ID.create()
      // The notice's row is written, then a later step of the same transaction fails: everything rolls back.
      const exit = yield* db
        .transaction(() =>
          sessions
            .synthetic({ sessionID, id: inputID, text: "a notice", source: "shell" })
            .pipe(Effect.andThen(Effect.die("rollback"))),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      // The ring its caller owes it, after the transaction ended: it re-reads the row, finds none, rings nothing.
      const decisions: SessionAdmission.Decision[] = []
      yield* SessionAdmission.ring({
        db,
        store,
        sessionID,
        inputID,
        wake: execution.wake,
        decided: (decision) => Effect.sync(() => void decisions.push(decision)),
      })
      yield* Effect.sleep(10)
      yield* execution.awaitIdle(sessionID)
      expect(decisions).toEqual(["gone"])
      expect(yield* SessionInbox.find(db, inputID)).toBeUndefined()
      expect(drains).toEqual([])
      expect(yield* sessions.messages({ sessionID })).toEqual([])
      current.drain = () => Effect.void
    }),
  )

  it.live("a ring asked for inside an open transaction is refused: it cannot see that transaction's commit", () =>
    Effect.gen(function* () {
      const execution = yield* SessionExecution.Service
      const store = yield* SessionStore.Service
      const { db } = yield* Database.Service
      const drains = yield* recording
      const sessionID = yield* seed("ses_ring_in_txn")
      const exit = yield* db
        .transaction(() => SessionAdmission.ring({ db, store, sessionID, wake: execution.wake }))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as { _tag?: string })._tag).toBe(
        "SessionAdmission.RingInTransaction",
      )
      yield* Effect.sleep(10)
      yield* execution.awaitIdle(sessionID)
      expect(drains).toEqual([])
      current.drain = () => Effect.void
    }),
  )

  it.live("a notice committed before the process died is rung by the restart sweep's rule: live once, held never", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const execution = yield* SessionExecution.Service
      const store = yield* SessionStore.Service
      const { db } = yield* Database.Service
      const drains = yield* recording
      const live = yield* seed("ses_crash_live")
      const archived = yield* seed("ses_crash_archived")
      yield* sessions.archive(archived)
      // Admitted as the restart sweep admits (no wake: the process dies before any ringer acts).
      const notices = { live: SessionMessage.ID.create(), archived: SessionMessage.ID.create() }
      yield* sessions.synthetic({ sessionID: live, id: notices.live, text: "done", source: "restart", resume: false })
      yield* sessions.synthetic({
        sessionID: archived,
        id: notices.archived,
        text: "done",
        source: "restart",
        resume: false,
      })
      // The next boot: the sweep rings each owed notice by its ID (restart-wake.ts ringOwed), after unarchiving too.
      yield* sessions.unarchive(archived)
      const ring = (sessionID: Session.ID, inputID: SessionMessage.ID) =>
        SessionAdmission.ring({ db, store, sessionID, inputID, wake: execution.wake })
      yield* ring(live, notices.live)
      yield* ring(archived, notices.archived)
      yield* Effect.sleep(10)
      yield* execution.awaitIdle(live)
      yield* execution.awaitIdle(archived)
      expect(drains.filter((drain) => drain.took.length > 0)).toEqual([{ sessionID: live, took: [notices.live] }])
      expect(yield* SessionAdmission.isHeld(db, notices.archived)).toBe(true)
      // The user's next prompt takes the held notice; the boot's sweep then drops its mark.
      yield* sessions.synthetic({ sessionID: archived, text: "the user's prompt", resume: false })
      yield* execution.resume(archived).pipe(Effect.ignore)
      yield* execution.awaitIdle(archived)
      expect(drains.at(-1)?.took).toContain(notices.archived)
      yield* SessionAdmission.sweep(db)
      expect(yield* SessionAdmission.isHeld(db, notices.archived)).toBe(false)
      current.drain = () => Effect.void
    }),
  )
})
