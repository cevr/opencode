// Fork feature (shell-restart-wake): the restart's recovered shell notices, over every ordering of the events that
// race in a real boot. The sweep's own steps per shell (its mark written, its notice admitted, its job row completed),
// its wake pass, work the new server gives the owner meanwhile (admitted, its turn's last inbox check, its settle),
// and a crash between any two of them followed by an independent boot on the same store. Each ordering runs the real
// SessionRestart, SessionExecution coordinator, inbox, jobs and KV; only the model is a drain that takes the inbox.
// Two properties hold for every ordering: no lost wake (each recovered notice reaches a drain that takes it, with no
// user prompt after the crash or the events) and no doubled notice. A drain that takes nothing (no model call) is allowed.
import type { FileSystem } from "@opencode/core/filesystem"
import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Scope } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Instance } from "@opencode/core/instance/service"
import { Job } from "@opencode/core/job"
import { JobTable } from "@opencode/core/job/sql"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Shell } from "@opencode/core/shell"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, SessionInbox.node, Job.node, KV.node, Session.node]),
  ),
)

const MARK = "session.restart-wake:"

type Event = `M${number}` | `A${number}` | `R${number}` | "W" | "U" | "L" | "T"

/** Every interleaving of two sequences, each kept in its own order. */
const interleavings = <A>(left: readonly A[], right: readonly A[]): A[][] =>
  left.length === 0
    ? [[...right]]
    : right.length === 0
      ? [[...left]]
      : [
          ...interleavings(left.slice(1), right).map((rest) => [left[0]!, ...rest]),
          ...interleavings(left, right.slice(1)).map((rest) => [right[0]!, ...rest]),
        ]

/** The orderings for `shells` recovered shells of one session: with or without work given meanwhile, crashing anywhere. */
const schedules = (shells: number) => {
  const sweep: Event[] = [
    ...Array.from({ length: shells }, (_, i) => [`M${i + 1}`, `A${i + 1}`, `R${i + 1}`] as Event[]).flat(),
    "W",
  ]
  const orders = [...interleavings<Event>(sweep, ["U", "L", "T"]), sweep]
  // `crash` is how many events ran before the server died; equal to the length, it did not die.
  return orders.flatMap((events) => Array.from({ length: events.length + 1 }, (_, crash) => ({ events, crash })))
}

// Named points the first server's real code stops at, released by the scheduler one event at a time.
const gates = () => {
  const reached = new Map<string, Deferred.Deferred<void>>()
  const released = new Map<string, Deferred.Deferred<void>>()
  const of = (map: Map<string, Deferred.Deferred<void>>, name: string) => {
    const found = map.get(name) ?? Deferred.makeUnsafe<void>()
    map.set(name, found)
    return found
  }
  const state = { crashed: false, closing: false }
  return {
    state,
    // Called by the code: say it is here, then wait to be let on. After the crash nothing goes on, until the test
    // closes the dead server (its finalizers must be able to end).
    at: (name: string) =>
      Effect.suspend(() =>
        state.closing
          ? Effect.void
          : state.crashed
            ? Effect.never
            : Deferred.succeed(of(reached, name), undefined).pipe(Effect.andThen(Deferred.await(of(released, name)))),
      ),
    reach: (name: string) => Deferred.await(of(reached, name)).pipe(Effect.timeout("5 seconds"), Effect.orDie),
    release: (name: string) => Deferred.succeed(of(released, name), undefined),
  }
}

describe("RestartWake over every ordering of a boot's events", () => {
  for (const shells of [1, 2])
    it.live(
      `${shells} recovered shell${shells === 1 ? "" : "s"} of one session: no lost wake, no doubled notice`,
      () =>
        Effect.gen(function* () {
          const all = schedules(shells)
          const failures: string[] = []
          let index = 0
          for (const schedule of all) {
            const failure = yield* run(`ses_rws${shells}_${index++}`, shells, schedule.events, schedule.crash)
            if (failure) failures.push(`${schedule.events.join(" ")} | crash after ${schedule.crash}: ${failure}`)
            if (failures.length >= 5) break
          }
          console.log(`restart-wake orderings: ${shells} shell(s), ${index} orderings ran, ${failures.length} failed`)
          expect(failures).toEqual([])
          expect(index).toBe(all.length)
        }),
      240_000,
    )
})

/** One ordering: returns why it broke a property, or undefined. */
const run = Effect.fnUntraced(function* (id: string, shells: number, events: readonly Event[], crash: number) {
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const kv = yield* KV.Service
  const store = yield* SessionStore.Service
  const sessionID = Session.ID.make(id)
  yield* seedSession(database, sessionID)
  const notices: SessionMessage.ID[] = []
  for (let shell = 1; shell <= shells; shell++) notices.push(yield* seedShell(database, sessionID, `sh_${id}_${shell}`))
  const taken = new Map<SessionMessage.ID, number>()
  // The model: a drain takes the steer items in the inbox (its inbox check), counting which notices it took.
  const take = Effect.gen(function* () {
    const before = new Set((yield* SessionInbox.list(database.db, sessionID)).map((item) => item.id))
    yield* SessionInbox.promote(database.db, bus, sessionID, "steer")
    const after = new Set((yield* SessionInbox.list(database.db, sessionID)).map((item) => item.id))
    for (const notice of notices)
      if (before.has(notice) && !after.has(notice)) taken.set(notice, (taken.get(notice) ?? 0) + 1)
  })

  // The first server: every step stops at a gate, and its first drain (the turn) stops before and after its check.
  const g = gates()
  const firstScope = yield* Scope.make()
  const counts = { M: 0, A: 0, R: 0, drains: 0 }
  const firstJobs = yield* Job.make.pipe(Effect.provideService(Scope.Scope, firstScope))
  const turnGated = events.includes("U")
  const first = yield* build(firstScope, {
    drain: Effect.suspend(() => {
      if (g.state.crashed) return Effect.never
      const turn = turnGated && counts.drains++ === 0
      if (!turn) return take
      return g.at("check").pipe(Effect.andThen(take), Effect.andThen(g.at("settle")))
    }),
    jobs: {
      ...firstJobs,
      completeBackground: (n) => firstJobs.completeBackground(n).pipe(Effect.andThen(g.at(`R${++counts.R}`))),
    },
    kv: {
      ...kv,
      set: (key, value) =>
        Effect.suspend(() => (g.state.crashed && !g.state.closing ? Effect.never : kv.set(key, value))).pipe(
          Effect.andThen(key.startsWith(MARK) ? g.at(`M${++counts.M}`) : Effect.void),
        ),
      scan: (options) => (options.prefix === MARK ? g.at("S") : Effect.void).pipe(Effect.andThen(kv.scan(options))),
    },
    admitted: (input) => (input.metadata?.source === "shell" ? g.at(`A${++counts.A}`) : Effect.void),
  })
  const execution = Context.get(first, SessionExecution.Service)
  const sweep = yield* g
    .at("start")
    .pipe(Effect.andThen(Context.get(first, SessionRestart.Service).resumeSuspendedSessions), Effect.forkIn(firstScope))
  // Each sweep event lets the sweep on from where it stopped to its next stop; its wake pass stops first at its scan.
  const sweepStops = ["start", ...events.filter((event) => /^[MAR]\d+$/.test(event)), "S"]
  let sweepAt = 0
  const advance = Effect.gen(function* () {
    yield* g.reach(sweepStops[sweepAt]!)
    yield* g.release(sweepStops[sweepAt]!)
    sweepAt++
    yield* g.reach(sweepStops[sweepAt]!)
  })
  const settled = Effect.gen(function* () {
    // The coordinator's own drains after a step run to the end: wait until the owner is idle again.
    yield* Effect.sleep(1)
    yield* execution.awaitIdle(sessionID).pipe(Effect.timeout("5 seconds"), Effect.orDie)
  })
  for (const event of events.slice(0, crash)) {
    if (event === "U") {
      yield* Context.get(first, Session.Service).synthetic({ sessionID, text: "work the new server was given" })
    } else if (event === "L") {
      yield* g.reach("check")
      yield* g.release("check")
      yield* g.reach("settle")
    } else if (event === "T") {
      yield* g.release("settle")
      yield* settled
    } else if (event === "W") {
      yield* advance
      yield* g.release("S")
      yield* Fiber.join(sweep).pipe(Effect.timeout("5 seconds"), Effect.orDie)
      // The turn may be the one this wake started: its first drain stops at its check, so do not wait for idle then.
      if (!turnGated) yield* settled
    } else yield* advance
  }

  const boot = Effect.fnUntraced(function* () {
    const scope = yield* Scope.make()
    const jobs = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
    const context = yield* build(scope, { drain: take, jobs, kv })
    const restarted = Context.get(context, SessionExecution.Service)
    yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
    for (let round = 0; round < 3; round++) {
      yield* Effect.sleep(1)
      yield* restarted.awaitIdle(sessionID).pipe(Effect.timeout("5 seconds"), Effect.orDie)
    }
    return scope
  })
  const scopes: Scope.Closeable[] = []
  if (crash < events.length) {
    // The server died here: nothing of it goes on. A new server boots on what it left.
    g.state.crashed = true
    scopes.push(yield* boot())
  } else yield* settled

  const inbox = new Set((yield* SessionInbox.list(database.db, sessionID)).map((item) => item.id))
  const delivered = new Map<string, number>()
  for (const message of yield* store.context(sessionID))
    if (message.type === "synthetic" && message.metadata?.source === "shell")
      delivered.set(message.id, (delivered.get(message.id) ?? 0) + 1)
  const broken: string[] = []
  for (const notice of notices) {
    if (inbox.has(notice)) broken.push(`${notice} lost: still in the inbox`)
    else if ((taken.get(notice) ?? 0) !== 1 || delivered.get(notice) !== 1)
      broken.push(`${notice} taken ${taken.get(notice) ?? 0}, delivered ${delivered.get(notice) ?? 0}`)
  }
  // One more restart afterwards: nothing is taken again and no mark is left.
  const takenBefore = [...taken.values()].reduce((a, b) => a + b, 0)
  scopes.push(yield* boot())
  if ([...taken.values()].reduce((a, b) => a + b, 0) !== takenBefore) broken.push("a later boot took a notice again")
  const left = (yield* kv.scan({ prefix: MARK })).entries.filter((entry) => entry.value === sessionID)
  if (left.length > 0) broken.push(`${left.length} mark(s) left after a later boot`)

  for (const scope of scopes) yield* Scope.close(scope, Exit.void)
  // The dead server's fibers are still parked at its gates: drop them now, its finalizers can no longer matter.
  g.state.crashed = true
  g.state.closing = true
  yield* Scope.close(firstScope, Exit.void)
  return broken.length === 0 ? undefined : broken.join("; ")
})

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

// The row a dead server left for a background shell still running when it died.
function seedShell(database: Database.Service["Service"], sessionID: Session.ID, shellID: string) {
  return Effect.gen(function* () {
    const notificationID = SessionMessage.ID.create()
    const now = Date.now()
    yield* database.db
      .insert(JobTable)
      .values({
        notification_id: notificationID,
        id: shellID,
        session_id: sessionID,
        kind: "shell",
        status: "running",
        recovery: { kind: "shell", sessionID, shellID, command: "sleep 60" },
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    return notificationID
  })
}

/** The real restart and execution over the harness's store, with the given drain, jobs and KV. */
function build(
  scope: Scope.Closeable,
  input: {
    readonly drain: Effect.Effect<void>
    readonly jobs: Job.Interface
    readonly kv: KV.Interface
    readonly admitted?: (input: { readonly metadata?: Record<string, unknown> }) => Effect.Effect<void>
  },
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const sessions = yield* Session.Service
    const inbox = yield* SessionInbox.Service
    const sessionLayer = Layer.effect(
      Session.Service,
      Effect.gen(function* () {
        const execution = yield* SessionExecution.Service
        return Session.Service.of({
          ...sessions,
          synthetic: (request) =>
            sessions.synthetic({ ...request, resume: false }).pipe(
              Effect.tap(() => (request.resume === false ? Effect.void : execution.wake(request.sessionID))),
              Effect.tap(() => input.admitted?.(request) ?? Effect.void),
            ),
        })
      }),
    )
    const runner = Layer.succeed(
      SessionRunner.Service,
      SessionRunner.Service.of({ drain: () => input.drain.pipe(Effect.as(SessionRunner.DrainResult.Complete())) }),
    )
    const locations = Layer.effect(
      LocationServiceMap.Service,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only the runner is used from a Location
      LayerMap.make(() => runner as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>),
    )
    return yield* Layer.buildWithScope(
      SessionRestart.layer().pipe(
        Layer.provideMerge(sessionLayer),
        Layer.provideMerge(Layer.fresh(SessionExecution.layer)),
        Layer.provide(Layer.succeed(Database.Service, database)),
        Layer.provide(Layer.succeed(Bus.Service, bus)),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(Layer.succeed(Job.Service, input.jobs)),
        Layer.provide(Layer.succeed(KV.Service, input.kv)),
        Layer.provide(
          Layer.succeed(
            Shell.Daemon,
            Shell.Daemon.of({
              at: () => Effect.die("no daemon registry"),
              watch: (effect) => effect.pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid),
              handoffPrepared: () => false,
            }),
          ),
        ),
        Layer.provide(Layer.succeed(SessionInbox.Service, inbox)),
        Layer.provide(
          AppNodeBuilder.build(Instance.node, [LocationServiceMap.node.replace(locations)]).pipe(Layer.fresh),
        ),
      ),
      scope,
    )
  })
}
