// Fork feature (shell-restart-wake): a scheduler that runs the restart's recovered shell notices over every ordering
// of the events that race in a real boot, on the real SessionRestart, SessionExecution coordinator, inbox, jobs and
// KV over one store. Only the model is a drain that takes the session's steer items.
//
// Events:
// - the sweep's own steps per shell i, each a stop on its real code path: `Mi` its mark written (KV), `Ai` its notice
//   admitted (Session.synthetic), `Ri` its job row completed (Job.completeBackground); then `W`, its wake pass (stopped
//   at its KV scan, then run to its end);
// - work the new server gives the first session meanwhile: `U` admitted (rings the doorbell), `L` its turn's inbox check
//   (the turn's first drain stops before and after it), `T` it settles, or `I` the user interrupts it;
// - `X` the owner archives the first session; `P` the user stops it (Session.stop: its turn ends, nothing revives it);
// - a crash after any prefix of the events: the first server is frozen (no gate opens, no drain, claim, wake or KV
//   write of it lands) and an independent server boots on the store it left. Every ordering ends with one more boot.
//
// Properties checked per ordering:
// - no lost wake: each recovered notice leaves the inbox, taken by a drain, with no user prompt after the crash or the
//   events (an interrupted turn included); except an archived or stopped owner's, which may stay queued;
// - no doubled notice, no cross-delivery: each is taken by at most one drain, appears once in its owner's messages and
//   in no other session's;
// - an archived or stopped session is not woken: after `X` or `P`, no drain takes a notice of it except a turn of the
//   user's (the one it ran, or that turn resumed after a crash);
// - the extra boot takes nothing and leaves no mark of these sessions;
// - after `X` or `P`: unarchived (or left stopped) and booted again, it is still not woken; the next prompt's turn
//   takes the notice still queued, once.
import type { FileSystem } from "@opencode/core/filesystem"
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
import { testEffect } from "../lib/effect"

export const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, SessionInbox.node, Job.node, KV.node, Session.node]),
  ),
)

const MARK = "session.restart-wake:"

export type Event = string

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

/** The sweep's events for `shells` recovered shells. */
export const sweep = (shells: number): Event[] => [
  ...Array.from({ length: shells }, (_, i) => [`M${i + 1}`, `A${i + 1}`, `R${i + 1}`]).flat(),
  "W",
]

/** `event` put at every position of each order. */
export const inserted = (orders: readonly Event[][], event: Event) =>
  orders.flatMap((order) =>
    Array.from({ length: order.length + 1 }, (_, at) => [...order.slice(0, at), event, ...order.slice(at)]),
  )

/** Each order with every crash point: `crash` events ran before the server died (the length: it did not die). */
export const crashes = (orders: readonly Event[][]) =>
  orders.flatMap((events) => Array.from({ length: events.length + 1 }, (_, crash) => ({ events, crash })))

export type Scenario = {
  /** The owning session (0 or 1) of each recovered shell. */
  readonly owners: readonly number[]
  readonly events: readonly Event[]
  readonly crash: number
}

/** Runs every scenario; returns how many ran and the first failures. */
export const runAll = Effect.fnUntraced(function* (label: string, scenarios: readonly Scenario[]) {
  const failures: string[] = []
  let ran = 0
  const started = Date.now()
  for (const scenario of scenarios) {
    const failure = yield* run(`ses_${label}_${ran++}`, scenario)
    if (failure) failures.push(`${scenario.events.join(" ")} | crash after ${scenario.crash}: ${failure}`)
    if (failures.length >= 5) break
  }
  console.log(
    `restart-wake orderings: ${label}, ${ran} orderings ran in ${Date.now() - started} ms, ${failures.length} failed`,
  )
  return { ran, failures }
})

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
  // After the crash nothing of the first server goes on, until the test closes it (its finalizers must end).
  const frozen = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => (state.crashed && !state.closing ? Effect.never : effect))
  return {
    state,
    frozen,
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

/** One ordering: returns why it broke a property, or undefined. */
const run = Effect.fnUntraced(function* (id: string, scenario: Scenario) {
  const { events, crash } = scenario
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const kv = yield* KV.Service
  const store = yield* SessionStore.Service
  const sessions = yield* Session.Service
  const owners = Array.from({ length: Math.max(...scenario.owners) + 1 }, (_, i) => Session.ID.make(`${id}_${i}`))
  for (const owner of owners) yield* seedSession(database, owner)
  const notices: { readonly id: SessionMessage.ID; readonly owner: Session.ID }[] = []
  for (const [shell, owner] of scenario.owners.entries())
    notices.push({ id: yield* seedShell(database, owners[owner]!, `sh_${id}_${shell + 1}`), owner: owners[owner]! })
  const first = owners[0]!
  const taken = new Map<SessionMessage.ID, number>()
  const marks: { quiet?: "archive" | "stop" } = {}
  const broken: string[] = []
  // The model: a drain takes its session's steer items (its inbox check), counting the notices it took.
  const take = (sessionID: Session.ID, turn: boolean) =>
    Effect.gen(function* () {
      const before = new Set((yield* SessionInbox.list(database.db, sessionID)).map((item) => item.id))
      yield* SessionInbox.promote(database.db, bus, sessionID, "steer")
      const after = new Set((yield* SessionInbox.list(database.db, sessionID)).map((item) => item.id))
      const took = [...before].filter((item) => !after.has(item))
      // A drain that also takes the user's work is that work's turn (resumed after a crash too), not a wake.
      const work = turn || took.some((item) => !notices.some((notice) => notice.id === item))
      for (const notice of notices)
        if (took.includes(notice.id)) {
          taken.set(notice.id, (taken.get(notice.id) ?? 0) + 1)
          if (sessionID === first && marks.quiet && !work) broken.push(`${notice.id} woken after the ${marks.quiet}`)
        }
    })

  // The first server: every step stops at a gate, and the first session's first drain (the turn) at its check.
  const g = gates()
  const firstScope = yield* Scope.make()
  const counts = { M: 0, A: 0, R: 0, drains: 0 }
  const firstJobs = yield* Job.make.pipe(Effect.provideService(Scope.Scope, firstScope))
  const turnGated = events.includes("U")
  const server = yield* build(firstScope, {
    drain: (sessionID) =>
      g.frozen(
        Effect.suspend(() => {
          const turn = turnGated && sessionID === first && counts.drains++ === 0
          if (!turn) return take(sessionID, false)
          return g.at("check").pipe(Effect.andThen(take(sessionID, true)), Effect.andThen(g.at("settle")))
        }),
      ),
    jobs: {
      ...firstJobs,
      completeBackground: (n) => g.frozen(firstJobs.completeBackground(n)).pipe(Effect.andThen(g.at(`R${++counts.R}`))),
    },
    kv: {
      ...kv,
      set: (key, value) =>
        g.frozen(kv.set(key, value)).pipe(Effect.andThen(key.startsWith(MARK) ? g.at(`M${++counts.M}`) : Effect.void)),
      remove: (key) => g.frozen(kv.remove(key)),
      scan: (options) => (options.prefix === MARK ? g.at("S") : Effect.void).pipe(Effect.andThen(kv.scan(options))),
    },
    admitted: (input) => (input.metadata?.source === "shell" ? g.at(`A${++counts.A}`) : Effect.void),
    frozen: g.frozen,
  })
  const execution = Context.get(server, SessionExecution.Service)
  const sweeping = yield* g
    .at("start")
    .pipe(
      Effect.andThen(Context.get(server, SessionRestart.Service).resumeSuspendedSessions),
      Effect.forkIn(firstScope),
    )
  // Each sweep event lets the sweep on from where it stopped to its next stop; its wake pass stops first at its scan.
  const stops = ["start", ...events.filter((event) => /^[MAR]\d+$/.test(event)), "S"]
  let at = 0
  const advance = Effect.gen(function* () {
    yield* g.reach(stops[at]!)
    yield* g.release(stops[at]!)
    at++
    yield* g.reach(stops[at]!)
  })
  // The coordinator's own drains after a step run to the end: wait until each owner is idle again.
  const settled = Effect.gen(function* () {
    for (let round = 0; round < 2; round++) {
      yield* Effect.sleep(1)
      for (const owner of owners) yield* execution.awaitIdle(owner).pipe(Effect.timeout("5 seconds"), Effect.orDie)
    }
  })
  // Where the first session's gated first drain (the turn) is: not begun, stopped at its check or its settle, or done.
  let turnAt: "none" | "check" | "settle" | "done" = turnGated ? "none" : "done"
  // A step's effects have landed: every drain it started has ended, or the gated turn has reached its stop. Nothing of
  // the first server (a claim, a drain) may land after a crash that follows.
  const quiet = Effect.gen(function* () {
    if (turnAt === "check" || turnAt === "settle") return yield* settled.pipe(Effect.raceFirst(g.reach(turnAt)))
    if (turnAt === "done") return yield* settled
    // The turn may begin now (a wake on an idle owner): it stops at its check.
    const begun = yield* settled.pipe(Effect.as(false), Effect.raceFirst(g.reach("check").pipe(Effect.as(true))))
    if (begun) turnAt = "check"
  })
  for (const event of events.slice(0, crash)) {
    if (event === "U") {
      yield* Context.get(server, Session.Service).synthetic({ sessionID: first, text: "work the new server was given" })
      // Its turn is under way (claimed, at its check) before anything else happens, a crash included.
      if (turnAt === "none") yield* g.reach("check")
      if (turnAt === "none") turnAt = "check"
    } else if (event === "L") {
      yield* g.reach("check")
      yield* g.release("check")
      yield* g.reach("settle")
      turnAt = "settle"
    } else if (event === "T") {
      yield* g.release("settle")
      turnAt = "done"
      yield* settled
    } else if (event === "I") {
      // The user interrupts the turn, before or after its check.
      yield* g.reach(turnAt === "settle" ? "settle" : "check")
      yield* execution.interrupt(first)
      turnAt = "done"
      yield* settled
    } else if (event === "P") {
      // The user stops the session (Session.stop): its turn, if one runs, ends, and nothing revives it.
      marks.quiet = "stop"
      yield* execution.stop(first)
      turnAt = "done"
      yield* settled
    } else if (event === "X") {
      yield* sessions.archive(first)
      marks.quiet = "archive"
      yield* quiet
    } else if (event === "W") {
      yield* advance
      yield* g.release("S")
      yield* Fiber.join(sweeping).pipe(Effect.timeout("5 seconds"), Effect.orDie)
      yield* quiet
    } else {
      yield* advance
      yield* quiet
    }
  }

  const boot = Effect.fnUntraced(function* () {
    const scope = yield* Scope.make()
    const jobs = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
    // A turn the dead server held is resumed (upstream's recovery): its drains are that turn's, not a wake.
    const resumed = new Set(yield* store.listSuspended())
    const context = yield* build(scope, { drain: (sessionID) => take(sessionID, resumed.has(sessionID)), jobs, kv })
    const restarted = Context.get(context, SessionExecution.Service)
    yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
    for (let round = 0; round < 3; round++) {
      yield* Effect.sleep(1)
      for (const owner of owners) yield* restarted.awaitIdle(owner).pipe(Effect.timeout("5 seconds"), Effect.orDie)
    }
    return { scope, execution: restarted }
  })
  const scopes: Scope.Closeable[] = []
  if (crash < events.length) {
    // The server died here: nothing of it goes on. A new server boots on what it left.
    g.state.crashed = true
    scopes.push((yield* boot()).scope)
  } else yield* settled

  const check = Effect.gen(function* () {
    const where = new Map<string, Session.ID[]>()
    for (const owner of owners)
      for (const message of yield* store.context(owner))
        if (message.type === "synthetic" && message.metadata?.source === "shell")
          where.set(message.id, [...(where.get(message.id) ?? []), owner])
    for (const notice of notices) {
      const pending = (yield* SessionInbox.list(database.db, notice.owner)).some((item) => item.id === notice.id)
      const seen = where.get(notice.id) ?? []
      const quiet = notice.owner === first && marks.quiet !== undefined
      if (seen.some((owner) => owner !== notice.owner)) broken.push(`${notice.id} reached another session`)
      if ((taken.get(notice.id) ?? 0) > 1 || seen.length > 1)
        broken.push(`${notice.id} doubled: taken ${taken.get(notice.id)}, delivered ${seen.length}`)
      if (pending && !quiet) broken.push(`${notice.id} lost: still in the inbox`)
      if (!pending && seen.length === 0) broken.push(`${notice.id} gone from the inbox and never delivered`)
    }
  })
  yield* check
  // One more restart afterwards: nothing is taken again and no mark is left.
  const total = () => [...taken.values()].reduce((a, b) => a + b, 0)
  const before = total()
  const later = yield* boot()
  scopes.push(later.scope)
  if (total() !== before) broken.push("a later boot took a notice")
  const left = (yield* kv.scan({ prefix: MARK })).entries.filter((entry) =>
    owners.some((owner) => entry.value === owner),
  )
  if (left.length > 0) broken.push(`${left.length} mark(s) left after a later boot`)

  if (marks.quiet) {
    // Unarchived (or left stopped) and booted once more: still not woken, the notice waits for the user.
    if (marks.quiet === "archive") yield* sessions.unarchive(first)
    const again = yield* boot()
    scopes.push(again.scope)
    if (total() !== before) broken.push(`woken after the ${marks.quiet} by a boot after it`)
    // The next prompt's turn takes what is still queued, once.
    yield* sessions.synthetic({ sessionID: first, text: "the next prompt", resume: false })
    yield* again.execution.resume(first)
    yield* Effect.sleep(1)
    yield* again.execution.awaitIdle(first).pipe(Effect.timeout("5 seconds"), Effect.orDie)
    for (const notice of notices) {
      if ((yield* SessionInbox.list(database.db, notice.owner)).some((item) => item.id === notice.id))
        broken.push(`${notice.id} not taken by the next prompt's turn`)
      if ((taken.get(notice.id) ?? 0) !== 1) broken.push(`${notice.id} taken ${taken.get(notice.id) ?? 0} times`)
    }
  }

  for (const scope of scopes) yield* Scope.close(scope, Exit.void)
  g.state.crashed = true
  g.state.closing = true
  yield* Scope.close(firstScope, Exit.void)
  return broken.length === 0 ? undefined : [...new Set(broken)].join("; ")
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
    readonly drain: (sessionID: Session.ID) => Effect.Effect<void>
    readonly jobs: Job.Interface
    readonly kv: KV.Interface
    readonly admitted?: (input: { readonly metadata?: Record<string, unknown> }) => Effect.Effect<void>
    // The dead server's wakes, recovers and resumes go nowhere after its crash.
    readonly frozen?: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
  },
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const sessions = yield* Session.Service
    const inbox = yield* SessionInbox.Service
    const frozen = input.frozen ?? (<A, E>(effect: Effect.Effect<A, E>) => effect)
    const execution = Layer.effect(
      SessionExecution.Service,
      Effect.gen(function* () {
        const real = yield* SessionExecution.Service
        return SessionExecution.Service.of({
          ...real,
          wake: (sessionID) => frozen(real.wake(sessionID)),
          recover: (sessionID) => frozen(real.recover(sessionID)),
          resume: (sessionID) => frozen(real.resume(sessionID)),
        })
      }),
    ).pipe(Layer.provide(Layer.fresh(SessionExecution.layer)))
    const sessionLayer = Layer.effect(
      Session.Service,
      Effect.gen(function* () {
        const wakes = yield* SessionExecution.Service
        return Session.Service.of({
          ...sessions,
          synthetic: (request) =>
            sessions.synthetic({ ...request, resume: false }).pipe(
              Effect.tap(() => (request.resume === false ? Effect.void : wakes.wake(request.sessionID))),
              Effect.tap(() => input.admitted?.(request) ?? Effect.void),
            ),
        })
      }),
    )
    const runner = Layer.succeed(
      SessionRunner.Service,
      SessionRunner.Service.of({
        drain: (request) => input.drain(request.sessionID).pipe(Effect.as(SessionRunner.DrainResult.Complete())),
      }),
    )
    const locations = Layer.effect(
      LocationServiceMap.Service,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only the runner is used from a Location
      LayerMap.make(() => runner as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>),
    )
    return yield* Layer.buildWithScope(
      SessionRestart.layer().pipe(
        Layer.provideMerge(sessionLayer),
        Layer.provideMerge(execution),
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
