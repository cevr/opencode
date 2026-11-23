// Fork feature (synthetic-archived): a scheduler that runs every source of non-user input (SessionAdmission.Sources),
// the user's own input and command, and the owner's actions over orderings of one or two sessions, on the real
// Session, SessionExecution coordinator, inbox, admission and KV over one store. Only the model is a drain that takes
// the session's pending input, and the user's turn is held open (`U` … `T`) so input can arrive while it runs.
//
// Events, each run until its effects settle (the race inside one admission is the transaction's, tested apart):
// - `A:<source>` admits from a source as its real caller does: `plugin` keeps its input (refused by an archived
//   session); `http` (the route cannot tell its callers apart), `shell`, `job`, `media`, `subagent` hold it (resume,
//   woken when live), `restart` holds it unwoken (resume: false, as the restart sweep admits);
// - `K` a plugin's message inside the user's own slash command on that session (the user's), `L` one inside the user's
//   command on the OTHER session (a plugin's), `F` one a fiber forked inside the user's command sends after the
//   command returned (a plugin's);
// - `W` the restart sweep's owed wake for the last restart notice (SessionAdmission.ring with its input ID): a boot;
// - `U` the user's prompt (its turn held open until `T`), `T` that turn ends;
// - `R` a waking notice admitted inside a transaction that rolls back after its row was written, then rung;
// - `X` archive, `Y` unarchive, `P` stop (Session.stop), `D` delete.
// A `@1` suffix aims the event at the second session.
//
// Properties per ordering:
// - refused: a keeping source's input to an archived session fails with Session.ArchivedError and leaves no row;
// - held: a holding source's input to an archived session is admitted, marked held, and no wake comes for it;
// - deleted: any input to a deleted session fails with Session.NotFoundError and leaves no row;
// - nothing on refusal: after a refused or missing call the session's rows are byte-identical to before it;
// - rollback: after `R` the session's rows are byte-identical to before it (no row, no held mark, no turn marker) and
//   no drain started;
// - no unsolicited turn: a drain that takes input while its session is archived or stopped takes the user's input
//   too (the user's turn), and held input never starts a turn alone (once unarchived it rides along a turn something
//   else started, as any pending input does); unarchiving (`Y`) and the restart's wake (`W`) take nothing held;
// - no cross-session effect: an event on one session starts no drain of the other;
// - once: no input is taken twice; at the end (unarchived, the user prompts each live session) every admitted input
//   is in its session's messages exactly once and no refused input is anywhere.
import type { FileSystem } from "@opencode/core/filesystem"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, LayerMap } from "effect"
import { sql } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionAdmission } from "@opencode/core/session/admission"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionInboxTable, SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { EventSequenceTable, EventTable } from "@opencode/core/event/sql"
import { KVTable } from "@opencode/core/kv/sql"
import { SessionStore } from "@opencode/core/session/store"
import { testEffect } from "../lib/effect"
import { database as testDatabase } from "./test-database"

/** The model's drain, swapped per ordering: the Location graph is built once. */
export const current: { drain: (sessionID: Session.ID) => Effect.Effect<void> } = { drain: () => Effect.void }

const runner = Layer.succeed(
  SessionRunner.Service,
  SessionRunner.Service.of({
    drain: (input) =>
      Effect.suspend(() => current.drain(input.sessionID)).pipe(Effect.as(SessionRunner.DrainResult.Complete())),
  }),
)
const locations = Layer.effect(
  LocationServiceMap.Service,
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only the runner is used from a Location
  LayerMap.make(() => runner as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>),
)

export const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      SessionInbox.node,
      Job.node,
      KV.node,
      Session.node,
      SessionExecution.node,
    ]),
    [testDatabase(), LocationServiceMap.node.replace(locations)],
  ),
)

export type Event = string

export const KEEPING = ["plugin"] as const
export const HOLDING = ["http", "shell", "job", "media", "subagent", "restart"] as const
/** Every source's admission event, the user's command's and the two that must not inherit it. */
export const ADMITS = [...KEEPING, ...HOLDING].map((source) => `A:${source}`).concat(["K", "L", "F"])

/** Every interleaving of two sequences, each kept in its own order. */
export const interleavings = <A>(left: readonly A[], right: readonly A[]): A[][] =>
  left.length === 0
    ? [[...right]]
    : right.length === 0
      ? [[...left]]
      : [
          ...interleavings(left.slice(1), right).map((rest) => [left[0]!, ...rest]),
          ...interleavings(left, right.slice(1)).map((rest) => [right[0]!, ...rest]),
        ]

type Admission = {
  readonly id: SessionMessage.ID
  readonly session: number
  readonly event: Event
  readonly user: boolean
  outcome?: "refused" | "held" | "live" | "missing"
  cancelled?: boolean
}

/** Runs every ordering; returns how many ran and the first failures. */
export const runAll = Effect.fnUntraced(function* (label: string, orders: readonly Event[][]) {
  const failures: string[] = []
  let ran = 0
  const started = Date.now()
  for (const events of orders) {
    const failure = yield* run(`ses_${label}_${ran++}`, events)
    if (failure) failures.push(`${events.join(" ")}: ${failure}`)
    if (failures.length >= 5) break
  }
  console.log(`admission orderings: ${label}, ${ran} ran in ${Date.now() - started} ms, ${failures.length} failed`)
  return { ran, failures }
})

/** One ordering: returns why it broke a property, or undefined. */
export const run = Effect.fnUntraced(function* (id: string, events: readonly Event[]) {
  const database = yield* Database.Service
  const db = database.db
  const sessions = yield* Session.Service
  const execution = yield* SessionExecution.Service
  const store = yield* SessionStore.Service
  const bus = yield* Bus.Service
  const ids = [Session.ID.make(`${id}_0`), Session.ID.make(`${id}_1`)]
  for (const sessionID of ids) yield* seedSession(database, sessionID)
  const state = ids.map(() => ({ archived: false, stopped: false, deleted: false }))
  const admissions: Admission[] = []
  const broken: string[] = []
  const taken = new Map<string, number>()
  // The user's open turn per session: its drain waits here until `T`.
  const gates: (Deferred.Deferred<void> | undefined)[] = [undefined, undefined]
  const turnPending = [false, false]
  let at = -1

  // Every drain the coordinator started per session, the empty ones included: a turn, with its markers.
  const drains = [0, 0]

  const admissionOf = (inputID: string) => admissions.find((admission) => admission.id === inputID)
  current.drain = (sessionID) =>
    Effect.gen(function* () {
      const index = ids.indexOf(sessionID)
      drains[index]!++
      const session = yield* store.get(sessionID)
      const archived = session?.time.archived !== undefined
      const stopped = yield* execution.stopped(sessionID)
      const event = at
      if (turnPending[index]) {
        turnPending[index] = false
        const gate = gates[index]
        if (gate) yield* Deferred.await(gate)
      }
      const before = (yield* SessionInbox.list(db, sessionID)).map((item) => item.id)
      while (((yield* SessionInbox.promote(db, bus, sessionID, "input")) ?? 0) > 0);
      const after = new Set((yield* SessionInbox.list(db, sessionID)).map((item) => item.id))
      const took = before.filter((item) => !after.has(item))
      if (took.length === 0) return
      for (const item of took) taken.set(item, (taken.get(item) ?? 0) + 1)
      const user = took.some((item) => admissionOf(item)?.user)
      const name = events[event] ?? "end"
      if (!user && archived) broken.push(`${name}: a turn in archived ${index} took ${took.length} without the user`)
      if (!user && stopped) broken.push(`${name}: a turn in stopped ${index} took ${took.length} without the user`)
      // A held input rides along a turn something else started (once unarchived), but never starts one itself.
      if (!user && took.every((item) => admissionOf(item)?.outcome === "held"))
        broken.push(`${name}: held input alone started a turn`)
      if (event >= 0 && event < events.length) {
        const target = target_(events[event]!)
        if (target !== index) broken.push(`${name}: a drain of session ${index}`)
      }
    })

  const settle = Effect.gen(function* () {
    for (let round = 0; round < 3; round++) {
      yield* Effect.sleep(1)
      for (const [index, sessionID] of ids.entries())
        if (gates[index] === undefined || (yield* Deferred.isDone(gates[index]!)))
          yield* execution.awaitIdle(sessionID).pipe(Effect.timeout("5 seconds"), Effect.orDie)
    }
  })

  /** The plugin host's ctx.session.synthetic (plugin/host.ts), as it is wired. */
  const hostSynthetic = (input: { sessionID: Session.ID; id: SessionMessage.ID; text: string }) =>
    SessionAdmission.pluginSource(input.sessionID).pipe(
      Effect.flatMap((source) => SessionAdmission.typed(sessions.synthetic({ ...input, source }))),
    )

  const admit = Effect.fnUntraced(function* (event: Event, index: number) {
    const sessionID = ids[index]!
    const inputID = SessionMessage.ID.create()
    const kind = event.split("@")[0]!
    const source = kind.startsWith("A:") ? (kind.slice(2) as SessionAdmission.Source) : undefined
    const s = state[index]!
    // Whose input it is, and so how an archived session answers.
    const rule =
      kind === "K" || kind === "U" ? "user" : kind === "L" || kind === "F" ? "refuse" : SessionAdmission.rule(source)
    const admission: Admission = { id: inputID, session: index, event, user: rule === "user" }
    admissions.push(admission)
    const call = (() => {
      if (kind === "U") return sessions.synthetic({ sessionID, id: inputID, text: "the user's prompt", resume: false })
      if (kind === "K")
        return SessionAdmission.userCommand(sessionID)(hostSynthetic({ sessionID, id: inputID, text: "k" }))
      if (kind === "L")
        return SessionAdmission.userCommand(ids[1 - index]!)(hostSynthetic({ sessionID, id: inputID, text: "l" }))
      if (kind === "F")
        return Effect.gen(function* () {
          const go = yield* Deferred.make<void>()
          const fiber = yield* SessionAdmission.userCommand(sessionID)(
            Effect.forkDetach(
              Deferred.await(go).pipe(Effect.andThen(hostSynthetic({ sessionID, id: inputID, text: "f" }))),
            ),
          )
          yield* Deferred.succeed(go, undefined)
          return yield* Fiber.join(fiber)
        })
      if (source === "plugin") return hostSynthetic({ sessionID, id: inputID, text: "a plugin's message" })
      return sessions.synthetic({
        sessionID,
        id: inputID,
        text: `${source}'s notice`,
        source,
        resume: source !== "restart",
      })
    })()
    const rows = yield* dump(db, sessionID)
    const exit = yield* Effect.exit(call as Effect.Effect<unknown, unknown>)
    const expected = s.deleted
      ? "missing"
      : s.archived && rule === "refuse"
        ? "refused"
        : s.archived && rule === "hold"
          ? "held"
          : "live"
    admission.outcome = expected
    const row = (yield* SessionInbox.find(db, inputID)) !== undefined || taken.has(inputID)
    if (expected === "missing" || expected === "refused") {
      const tag = Exit.isFailure(exit)
        ? String((Cause.squash(exit.cause) as { _tag?: string })?._tag ?? Cause.pretty(exit.cause))
        : "success"
      const want = expected === "missing" ? "Session.NotFoundError" : "Session.ArchivedError"
      if (!tag.includes(want)) broken.push(`${event}: expected ${want}, got ${tag}`)
      if (row) broken.push(`${event}: a ${expected} input left a row`)
      // A refused call changes nothing: the session's rows are byte-identical to before it.
      if ((yield* dump(db, sessionID)) !== rows) broken.push(`${event}: a ${expected} call changed the session's rows`)
      return
    }
    if (Exit.isFailure(exit)) return void broken.push(`${event}: admission failed: ${exit.cause}`)
    if (!row) broken.push(`${event}: admitted input has no row`)
    const held = yield* SessionAdmission.isHeld(db, inputID)
    if (held !== (expected === "held")) broken.push(`${event}: held mark ${held}, expected ${expected}`)
    if (kind === "U") {
      s.stopped = false
      // The user's turn: held open until `T` when the ordering ends it, else run through.
      const open = events.slice(at + 1).some((later) => later === (index === 0 ? "T" : "T@1"))
      if (open) {
        gates[index] = yield* Deferred.make<void>()
        turnPending[index] = true
      }
      yield* execution.resume(sessionID).pipe(Effect.ignore, Effect.forkDetach)
    }
  })

  for (const [index, event] of events.entries()) {
    at = index
    const target = target_(event)!
    const sessionID = ids[target]!
    const s = state[target]!
    const kind = event.split("@")[0]!
    if (kind === "X") {
      if (!s.deleted) yield* sessions.archive(sessionID).pipe(Effect.orDie)
      s.archived = !s.deleted
    } else if (kind === "Y") {
      if (!s.deleted) yield* sessions.unarchive(sessionID).pipe(Effect.orDie)
      s.archived = false
    } else if (kind === "P") {
      if (!s.deleted) {
        yield* sessions.stop(sessionID).pipe(Effect.orDie)
        // Session.stop drops queued input: what was pending goes with it.
        for (const admission of admissions)
          if (admission.session === target && !taken.has(admission.id)) admission.cancelled = true
        s.stopped = true
        if (gates[target]) yield* Deferred.succeed(gates[target]!, undefined)
      }
    } else if (kind === "D") {
      if (gates[target]) yield* Deferred.succeed(gates[target]!, undefined)
      if (!s.deleted) yield* sessions.remove(sessionID).pipe(Effect.orDie)
      s.deleted = true
    } else if (kind === "T") {
      if (gates[target]) yield* Deferred.succeed(gates[target]!, undefined)
    } else if (kind === "W") {
      const notice = admissions.findLast(
        (admission) => admission.session === target && admission.event.startsWith("A:restart"),
      )
      const before = [...taken.values()].reduce((a, b) => a + b, 0)
      if (notice && !s.deleted)
        yield* SessionAdmission.ring({
          db,
          store,
          sessionID,
          inputID: notice.id,
          // As the restart sweep rings (restart-wake.ts ringOwed): a stopped owner is not woken.
          wake: (owner) =>
            execution.stopped(owner).pipe(Effect.flatMap((held) => (held ? Effect.void : execution.wake(owner)))),
        })
      yield* settle
      const after = [...taken.values()].reduce((a, b) => a + b, 0)
      if (notice?.outcome === "held" && after !== before && !gates[target])
        broken.push(`W: the restart's wake took a held notice`)
      continue
    } else if (kind === "R") {
      // A notice (a waking source) whose admitting transaction rolls back after its row was written (a later step of
      // the caller's transaction failing), then the ring its caller rings for it: no turn, no marker, no row.
      const inputID = SessionMessage.ID.create()
      const rows = yield* dump(db, sessionID)
      const started = drains[target]!
      const rolled = yield* db
        .transaction(() =>
          sessions
            .synthetic({ sessionID, id: inputID, text: "rolled back", source: "shell" })
            .pipe(Effect.andThen(Effect.die("rollback"))),
        )
        .pipe(Effect.exit)
      if (Exit.isSuccess(rolled)) broken.push("R: the transaction did not roll back")
      const decisions: SessionAdmission.Decision[] = []
      if (!s.deleted)
        yield* SessionAdmission.ring({
          db,
          store,
          sessionID,
          inputID,
          wake: execution.wake,
          decided: (decision) => Effect.sync(() => void decisions.push(decision)),
        })
      yield* settle
      if (!s.deleted && decisions.join() !== "gone") broken.push(`R: the ring decided ${decisions.join() || "nothing"}`)
      if (drains[target] !== started) broken.push("R: a rolled-back admission started a turn")
      if ((yield* dump(db, sessionID)) !== rows) broken.push("R: a rolled-back admission left a trace")
      continue
    } else yield* admit(event, target)
    const before = [...taken.values()].reduce((a, b) => a + b, 0)
    yield* settle
    if (kind === "Y" && [...taken.values()].reduce((a, b) => a + b, 0) !== before)
      broken.push("Y: unarchiving started a turn")
  }

  // The end: release open turns, unarchive, and the user prompts each live session once.
  at = events.length
  for (const gate of gates) if (gate) yield* Deferred.succeed(gate, undefined)
  yield* settle
  for (const [index, sessionID] of ids.entries()) {
    const s = state[index]!
    if (s.deleted) continue
    if (s.archived) yield* sessions.unarchive(sessionID).pipe(Effect.orDie)
    yield* settle
    const inputID = SessionMessage.ID.create()
    admissions.push({ id: inputID, session: index, event: "end", user: true, outcome: "live" })
    yield* sessions.synthetic({ sessionID, id: inputID, text: "the next prompt", resume: false })
    yield* execution.resume(sessionID).pipe(Effect.ignore)
    yield* settle
  }
  for (const admission of admissions) {
    const count = taken.get(admission.id) ?? 0
    if (count > 1) broken.push(`${admission.event}: taken ${count} times`)
    const s = state[admission.session]!
    if (admission.outcome === "refused" || admission.outcome === "missing") {
      if (count > 0) broken.push(`${admission.event}: a ${admission.outcome} input was taken`)
      continue
    }
    if (s.deleted || admission.cancelled) continue
    if (count !== 1) broken.push(`${admission.event}: never taken (by the next prompt)`)
  }
  for (const [index, sessionID] of ids.entries()) {
    if (state[index]!.deleted) continue
    const seen = (yield* store.context(sessionID)).map((message) => message.id)
    for (const admission of admissions)
      if (seen.includes(admission.id) && admission.session !== index)
        broken.push(`${admission.event}: reached the other session`)
  }
  current.drain = () => Effect.void
  return broken.length === 0 ? undefined : [...new Set(broken)].join("; ")
})

/** Every row of one session (the session, its messages, inbox, events, sequence and KV marks), as one string. */
export const dump = (db: Database.Interface["db"], sessionID: string) =>
  Effect.all([
    db.all(sql`SELECT * FROM ${SessionTable} WHERE id = ${sessionID}`),
    db.all(sql`SELECT * FROM ${SessionMessageTable} WHERE session_id = ${sessionID} ORDER BY seq`),
    db.all(sql`SELECT * FROM ${SessionInboxTable} WHERE session_id = ${sessionID} ORDER BY id`),
    db.all(sql`SELECT * FROM ${EventTable} WHERE aggregate_id = ${sessionID} ORDER BY seq`),
    db.all(sql`SELECT * FROM ${EventSequenceTable} WHERE aggregate_id = ${sessionID}`),
    db.all(sql`SELECT * FROM ${KVTable} WHERE value = ${JSON.stringify(sessionID)} ORDER BY key`),
  ]).pipe(
    Effect.map((rows) => JSON.stringify(rows)),
    Effect.orDie,
  )

/** The session an event aims at. */
const target_ = (event: Event) => (event.endsWith("@1") ? 1 : 0)

function seedSession(database: Database.Service["Service"], id: Session.ID) {
  return Effect.gen(function* () {
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test" })
      .run()
      .pipe(Effect.orDie)
  })
}
