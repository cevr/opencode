import type { FileSystem } from "@opencode/core/filesystem"
import { describe, expect, test } from "bun:test"
import { AIError, TransportError } from "@opencode/ai/effect"
import { Money } from "@opencode/schema/money"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
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
import { SessionEvent } from "@opencode/core/session/event"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionStepRoute } from "@opencode/core/session/step-route"
import { SessionInboxTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Shell } from "@opencode/core/shell"
import { BlobStore } from "@opencode/core/blob-store"
import { Environment } from "@opencode/core/environment/index"
import { VideoGeneration } from "@opencode/core/video-generation"
import { VideoID } from "@opencode/schema/generate"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { Agent } from "@opencode/core/agent"
import { ID } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { daemonShells } from "./fixture/shell-daemon"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Logger, Schedule, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, SessionInbox.node, Job.node, KV.node, Session.node]),
  ),
)

describe("SessionExecution lifecycle", () => {
  test("classifies success and typed failure terminals", () => {
    expect(SessionExecution.terminal(Exit.succeed(undefined))).toEqual({ type: "succeeded" })
    expect(
      SessionExecution.terminal(
        Exit.fail(
          new AIError({
            reason: new TransportError({ message: "Disconnected", transport: "http", operation: "request" }),
          }),
        ),
      ),
    ).toEqual({ type: "failed", error: { type: "provider.transport", message: "Disconnected" } })
  })

  test("defaults owner-scope interruption to shutdown and preserves explicit reasons", () => {
    const interrupted = Effect.runSyncExit(Effect.interrupt)
    expect(SessionExecution.terminal(interrupted)).toEqual({ type: "interrupted", reason: "shutdown" })
    expect(SessionExecution.terminal(interrupted, "user")).toEqual({ type: "interrupted", reason: "user" })
  })

  it.effect("resumes a directly driven child after execution teardown", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const parent = Session.ID.make("ses_recover_parent")
      const child = Session.ID.make("ses_recover_child")
      const idle = Session.ID.make("ses_recover_idle")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child, idle], { parent_id: parent })
      const scope = yield* Scope.fork(yield* Effect.scope)
      const running = yield* Deferred.make<void>()
      const before = yield* buildExecution(scope, () =>
        Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never)),
      )
      yield* Context.get(before, SessionExecution.Service).resume(child).pipe(Effect.forkIn(scope))
      yield* Deferred.await(running)
      yield* Scope.close(scope, Exit.void)
      expect((yield* claims(database))[child]).toBe(true)

      const drained: Session.ID[] = []
      const resumed = yield* Deferred.make<void>()
      const after = yield* buildExecution(yield* Scope.fork(yield* Effect.scope), ({ sessionID }) =>
        Effect.sync(() => void drained.push(sessionID)).pipe(Effect.andThen(Deferred.succeed(resumed, undefined))),
      )
      const restart = Context.get(after, SessionRestart.Service)
      yield* restart.resumeSuspendedSessions
      expect((yield* store.context(child)).filter((message) => message.type === "synthetic")).toMatchObject([
        { metadata: { notice: "restart" } },
      ])
      yield* Deferred.await(resumed)
      yield* Context.get(after, SessionExecution.Service).awaitIdle(child)
      yield* restart.resumeSuspendedSessions
      expect(drained).toEqual([child])
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false, [idle]: false })
    }),
  )

  it.effect("keeps a stop the server died inside: the sweep settles the stopped child instead of resuming it", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const kv = yield* KV.Service
      const parent = Session.ID.make("ses_stop_restart_parent")
      const child = Session.ID.make("ses_stop_restart_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      const scope = yield* Scope.fork(yield* Effect.scope)
      const running = yield* Deferred.make<void>()
      const before = yield* buildExecution(scope, () =>
        Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never)),
      )
      yield* Context.get(before, SessionExecution.Service).resume(child).pipe(Effect.forkIn(scope))
      yield* Deferred.await(running)
      // SessionExecution.stop's first step, its durable mark; the server dies before the interrupt settles.
      yield* kv.set("session.stopped:" + child, true)
      yield* Scope.close(scope, Exit.void)
      expect((yield* claims(database))[child]).toBe(true)

      const drained: Session.ID[] = []
      const after = yield* buildExecution(yield* Scope.fork(yield* Effect.scope), ({ sessionID }) =>
        Effect.sync(() => void drained.push(sessionID)),
      )
      const restart = Context.get(after, SessionRestart.Service)
      const execution = Context.get(after, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* Effect.yieldNow
      yield* Effect.forEach([child, parent], execution.awaitIdle)
      expect({ drained, stopped: yield* execution.stopped(child) }).toEqual({ drained: [], stopped: true })
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
      expect((yield* store.context(child)).filter((message) => message.type === "synthetic")).toEqual([])
      // A directly driven child reports nothing to its parent once stopped, as a settled stop does.
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
      yield* restart.resumeSuspendedSessions
      expect(drained).toEqual([])
    }),
  )

  it.effect("recover continues a claimed turn but never runs or ends a stop; resume, new work, ends it", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const kv = yield* KV.Service
      const session = Session.ID.make("ses_recover_stopped")
      yield* seedSessions(database, [session])
      const drained: Session.ID[] = []
      const context = yield* buildExecution(yield* Scope.fork(yield* Effect.scope), ({ sessionID }) =>
        Effect.sync(() => void drained.push(sessionID)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* kv.set("session.stopped:" + session, true)
      yield* execution.recover(session)
      expect({ drained, stopped: yield* execution.stopped(session) }).toEqual({ drained: [], stopped: true })
      yield* execution.resume(session)
      expect({ drained, stopped: yield* execution.stopped(session) }).toEqual({ drained: [session], stopped: false })
      yield* execution.recover(session)
      expect(drained).toEqual([session, session])
    }),
  )

  it.effect("keeps a stop the server died inside: a stopped background child reports cancelled once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const kv = yield* KV.Service
      const parent = Session.ID.make("ses_stop_restart_job_parent")
      const child = Session.ID.make("ses_stop_restart_job_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now() })
      // The child's subagent job is still running when the server dies inside the child's stop.
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Stopped inspection",
        },
        run: Effect.never,
      })
      yield* jobs.background(child)
      yield* kv.set("session.stopped:" + child, true)

      const drained: Session.ID[] = []
      const parentWoken = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(sessionID === parent ? Deferred.succeed(parentWoken, undefined) : Effect.void),
          ),
        undefined,
        restarted,
      )
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* Deferred.await(parentWoken)
      yield* Effect.forEach([child, parent], execution.awaitIdle)
      expect({ drained, stopped: yield* execution.stopped(child) }).toEqual({ drained: [parent], stopped: true })
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        {
          payload: {
            text: expect.stringContaining("Subagent cancelled"),
            metadata: { source: "subagent", childID: child, state: "cancelled" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
      yield* restart.resumeSuspendedSessions
      expect(drained).toEqual([parent])
      expect(yield* SessionInbox.list(database.db, parent)).toHaveLength(1)
    }),
  )

  // The server serves while its sweep runs (packages/server/src/process.ts forks the sweep before the routes start),
  // so a stop or a new task can land between the sweep's read of a stop mark and what it does with that read.
  it.effect("a stop that lands just after the sweep read the mark settles the child: no run, claim released", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const parent = Session.ID.make("ses_race_stop_parent")
      const child = Session.ID.make("ses_race_stop_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now() })
      const race = yield* raceOnMark(child)
      const drained: Session.ID[] = []
      const after = yield* buildExecution(
        yield* Scope.fork(yield* Effect.scope),
        ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)),
        undefined,
        undefined,
        undefined,
        undefined,
        race.kv,
      )
      const execution = Context.get(after, SessionExecution.Service)
      race.arm(execution.stop(child).pipe(Effect.asVoid))
      yield* Context.get(after, SessionRestart.Service).resumeSuspendedSessions
      yield* race.fired
      // The sweep forks the direct resume: let it start before waiting for the child to settle.
      yield* Effect.yieldNow
      yield* Effect.forEach([child, parent], execution.awaitIdle)
      expect({ drained, stopped: yield* execution.stopped(child) }).toEqual({ drained: [], stopped: true })
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
    }),
  )

  it.effect("a stop that lands just after the sweep read a background child's mark reports cancelled once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_race_stop_job_parent")
      const child = Session.ID.make("ses_race_stop_job_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now() })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Raced inspection",
        },
        run: Effect.never,
      })
      yield* jobs.background(child)
      const race = yield* raceOnMark(child)
      const drained: Session.ID[] = []
      const parentWoken = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(sessionID === parent ? Deferred.succeed(parentWoken, undefined) : Effect.void),
          ),
        undefined,
        restarted,
        undefined,
        undefined,
        race.kv,
      )
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      race.arm(execution.stop(child).pipe(Effect.asVoid))
      yield* restart.resumeSuspendedSessions
      yield* race.fired
      yield* Deferred.await(parentWoken)
      yield* Effect.forEach([child, parent], execution.awaitIdle)
      expect({ drained, stopped: yield* execution.stopped(child) }).toEqual({ drained: [parent], stopped: true })
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        {
          payload: {
            text: expect.stringContaining("Subagent cancelled"),
            metadata: { source: "subagent", childID: child, state: "cancelled" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
      yield* restart.resumeSuspendedSessions
      expect(drained).toEqual([parent])
      expect(yield* SessionInbox.list(database.db, parent)).toHaveLength(1)
    }),
  )

  it.effect("a new task that lands just after the sweep read the stop mark runs, and the sweep leaves it running", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const kv = yield* KV.Service
      const parent = Session.ID.make("ses_race_task_parent")
      const child = Session.ID.make("ses_race_task_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now() })
      // The server died inside the child's stop; the parent gives the child a new task at boot.
      yield* kv.set("session.stopped:" + child, true)
      const race = yield* raceOnMark(child)
      const drained: Session.ID[] = []
      const running = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.fork(yield* Effect.scope)
      const after = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(Deferred.succeed(running, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        undefined,
        undefined,
        undefined,
        undefined,
        race.kv,
      )
      const execution = Context.get(after, SessionExecution.Service)
      race.arm(
        execution.resume(child).pipe(Effect.ignore, Effect.forkIn(scope), Effect.andThen(Deferred.await(running))),
      )
      yield* Context.get(after, SessionRestart.Service).resumeSuspendedSessions
      yield* race.fired
      // The new task's turn holds its claim while it runs: the sweep must not settle it as the old stop.
      expect({ claimed: (yield* claims(database))[child], stopped: yield* execution.stopped(child) }).toEqual({
        claimed: true,
        stopped: false,
      })
      yield* Deferred.succeed(release, undefined)
      yield* execution.awaitIdle(child)
      expect(drained).toEqual([child])
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
    }),
  )

  it.effect("leaves a child parked when its parent is gone or its restart budget is exhausted", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const parent = Session.ID.make("ses_child_budget_parent")
      const exhausted = Session.ID.make("ses_child_budget_exhausted")
      const orphan = Session.ID.make("ses_child_budget_orphan")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [exhausted], { parent_id: parent, time_suspended: Date.now(), resume_attempts: 2 })
      yield* seedSessions(database, [orphan], { parent_id: Session.ID.make("ses_deleted"), time_suspended: Date.now() })
      const drained: Session.ID[] = []
      const context = yield* buildExecution(
        yield* Scope.fork(yield* Effect.scope),
        ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)),
        { maxAttempts: 2 },
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Effect.forEach([exhausted, orphan], Context.get(context, SessionExecution.Service).awaitIdle)
      expect(drained).toEqual([])
      expect(yield* claims(database)).toEqual({ [parent]: false, [exhausted]: false, [orphan]: false })
      expect(yield* attempts(database, exhausted)).toBe(0)
    }),
  )

  it.effect("claims at execution start, releases on completion, and preserves through teardown", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const interrupted = Session.ID.make("ses_claim_interrupted")
      const completed = Session.ID.make("ses_claim_completed")
      yield* seedSessions(database, [interrupted, completed])

      // Each drain signals once it runs; the claim commits before the drain starts.
      const interruptedRunning = yield* Deferred.make<void>()
      const completedRunning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        sessionID === completed
          ? Deferred.succeed(completedRunning, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Deferred.succeed(interruptedRunning, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const completedActive = execution.isActive(completed)
      expect(yield* completedActive).toBe(false)
      yield* execution.resume(interrupted).pipe(Effect.forkScoped)
      const completing = yield* execution.resume(completed).pipe(Effect.forkIn(scope))
      yield* Deferred.await(interruptedRunning)
      yield* Deferred.await(completedRunning)

      // The write-ahead claim exists WHILE the turns run — no shutdown hook involved.
      expect(yield* claims(database)).toEqual({ [interrupted]: true, [completed]: true })
      expect(yield* completedActive).toBe(true)
      expect(yield* execution.isActive(interrupted)).toBe(true)

      // A drain that finishes on its own releases its claim.
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(completing)
      yield* execution.awaitIdle(completed)
      expect((yield* claims(database))[completed]).toBe(false)
      expect(yield* completedActive).toBe(false)
      expect(yield* execution.isActive(interrupted)).toBe(true)

      // Teardown interruption (graceful twin of an unclean death) preserves the claim
      // for the next server start.
      yield* Scope.close(scope, Exit.void)
      expect((yield* claims(database))[interrupted]).toBe(true)
      expect(yield* execution.isActive(interrupted)).toBe(false)
    }),
  )

  it.effect("a user interrupt releases the claim so the turn never resurrects", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_claim_user_cancel")
      yield* seedSessions(database, [sessionID])

      const draining = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)
      expect((yield* claims(database))[sessionID]).toBe(true)

      expect(yield* execution.interrupt(sessionID)).toBeTrue()
      yield* execution.awaitIdle(sessionID)
      expect((yield* claims(database))[sessionID]).toBe(false)
    }),
  )

  it.effect("tells the drain once the user stopped it", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_interruption_user")
      yield* seedSessions(database, [sessionID])
      const draining = yield* Deferred.make<(() => string | undefined) | undefined>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Deferred.succeed(draining, input.interruption).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      const reason = yield* Deferred.await(draining)
      // Teardown interrupts without a reason, so only a user's stop reads as one.
      expect(reason?.()).toBeUndefined()
      yield* execution.interrupt(sessionID)
      expect(reason?.()).toBe("user")
      yield* execution.awaitIdle(sessionID)
    }),
  )

  it.effect("reports an idle interrupt as a no-op", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_idle_cancel")
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.never)
      const execution = Context.get(context, SessionExecution.Service)

      expect(yield* execution.interrupt(sessionID)).toBeFalse()
      expect(yield* execution.active).not.toContain(sessionID)
      expect(yield* execution.isActive(sessionID)).toBe(false)
    }),
  )

  it.effect("does not resume a user-cancelled background child whose notification was not admitted", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const parent = Session.ID.make("ses_cancelled_background_parent")
      const child = Session.ID.make("ses_cancelled_background_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })

      const running = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const jobs = yield* Job.make.pipe(Scope.provide(scope))
      const context = yield* buildExecution(
        scope,
        () => Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never)),
        undefined,
        jobs,
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "general",
          description: "Cancelled inspection",
        },
        run: execution.resume(child).pipe(Effect.as("unused")),
      })
      yield* jobs.background(child)
      yield* Deferred.await(running)
      expect(yield* execution.interrupt(child)).toBeTrue()
      yield* execution.awaitIdle(child)
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
      // Wave 2 reports a user cancel as soon as the busy period settles and acknowledges it.
      const immediate = (yield* SessionInbox.list(database.db, parent)).find((item) => item.type === "synthetic")
      expect(immediate).toMatchObject({
        payload: { text: expect.stringContaining("Subagent cancelled"), metadata: { state: "cancelled" } },
      })
      expect(yield* jobs.pendingBackground).toEqual([])
      yield* Scope.close(scope, Exit.void)

      // Reproduce a crash after the terminal commit but before admission: the child is idle,
      // the admitted notice is gone, and only the durable marker remains.
      if (!immediate) return yield* Effect.die("cancelled report missing")
      yield* database.db
        .delete(SessionInboxTable)
        .where(eq(SessionInboxTable.id, immediate.id))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(JobTable)
        .values({
          notification_id: immediate.id,
          id: child,
          session_id: parent,
          child_session_id: child,
          kind: "subagent",
          title: "Cancelled inspection",
          status: "cancelled",
          recovery: {
            kind: "subagent",
            parentSessionID: parent,
            childSessionID: child,
            agent: "general",
            description: "Cancelled inspection",
          },
        })
        .run()
        .pipe(Effect.orDie)

      const restartedScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(restartedScope, Exit.void))
      const restartedJobs = yield* Job.make.pipe(Scope.provide(restartedScope))
      const drained: Session.ID[] = []
      const restarted = yield* buildExecution(
        restartedScope,
        ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)),
        undefined,
        restartedJobs,
      )
      yield* Context.get(restarted, SessionRestart.Service).resumeSuspendedSessions
      yield* Context.get(restarted, SessionExecution.Service).awaitIdle(parent)
      expect(drained).toEqual([parent])
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        { payload: { text: expect.stringContaining("Subagent cancelled"), metadata: { state: "cancelled" } } },
      ])
      expect(yield* restartedJobs.pendingBackground).toEqual([])
    }),
  )

  it.effect("honors a job cancellation persisted before its child could release the claim", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_cancel_parent")
      const child = Session.ID.make("ses_cancel_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now(), resume_attempts: 1 })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          childSessionID: child,
          parentSessionID: parent,
          agent: "general",
          description: "Inspect",
        },
        background: true,
        run: Effect.never,
      })
      yield* jobs.cancel(child)
      const scope = yield* Scope.fork(yield* Effect.scope)
      const restarted = yield* Job.make.pipe(Scope.provide(scope))
      const drained: Session.ID[] = []
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)),
        undefined,
        restarted,
      )
      const restart = Context.get(context, SessionRestart.Service)
      yield* restart.resumeSuspendedSessions
      yield* Context.get(context, SessionExecution.Service).awaitIdle(parent)
      yield* restart.resumeSuspendedSessions
      expect(drained).toEqual([parent])
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        { payload: { metadata: { state: "cancelled" } } },
      ])
      expect((yield* claims(database))[child]).toBe(false)
      expect(yield* attempts(database, child)).toBe(0)
    }),
  )

  it.effect("starts every claimed execution without waiting for earlier drains to finish", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionIDs = Array.from({ length: 5 }, (_, index) => Session.ID.make(`ses_resume_concurrent_${index}`))
      yield* seedSessions(database, sessionIDs, { time_suspended: Date.now() })

      const fourStarted = yield* Deferred.make<void>()
      const started: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        Effect.sync(() => {
          started.push(sessionID)
          if (started.length === 4) Deferred.doneUnsafe(fourStarted, Effect.void)
        }).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)
      yield* restart.resumeSuspendedSessions.pipe(Effect.forkIn(scope))
      yield* Deferred.await(fourStarted)

      expect([...(yield* execution.active)].toSorted()).toEqual(sessionIDs.toSorted())
    }),
  )

  it.effect("resumes each claimed Session at most once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const first = Session.ID.make("ses_resume_first")
      const second = Session.ID.make("ses_resume_second")
      yield* seedSessions(database, [first, second], { time_suspended: Date.now() })

      const drained: string[] = []
      const bothDraining = yield* Deferred.make<void>()
      const continued: SessionEvent.Synthetic[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        Effect.sync(() => {
          drained.push(sessionID)
          if (drained.length === 2) Deferred.doneUnsafe(bothDraining, Effect.void)
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)
      yield* bus.project(SessionEvent.Synthetic, (event) => Effect.sync(() => void continued.push(event)))

      // The sweep forks resumed drains, so completion is observed through the executions.
      yield* restart.resumeSuspendedSessions
      yield* Deferred.await(bothDraining)
      yield* Effect.forEach([first, second], execution.awaitIdle, { discard: true })
      expect(drained.toSorted()).toEqual([first, second])
      expect(continued.map((event) => event.data).toSorted((a, b) => a.sessionID.localeCompare(b.sessionID))).toEqual(
        [first, second].map((sessionID) => ({
          sessionID,
          text: "The server restarted while you were working. Continue from where you left off without repeating completed work.",
          description: "Continuing after restart",
          metadata: { notice: "restart" },
        })),
      )
      // Drains completed naturally, so claims are released and counters reset.
      expect(yield* claims(database)).toEqual({ [first]: false, [second]: false })
      expect(yield* attempts(database, first)).toBe(0)

      yield* restart.resumeSuspendedSessions
      expect(drained.length).toBe(2)
      expect(continued.length).toBe(2)
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("terminalizes a turn that exhausts its resume budget instead of crash-looping", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const sessionID = Session.ID.make("ses_resume_exhausted")
      // A claim from a dead process, already resumed twice without completing.
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now(), resume_attempts: 2 })

      const drained: string[] = []
      const failures: SessionEvent.Execution.Failed[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID: id }) => Effect.sync(() => void drained.push(id)), {
        maxAttempts: 2,
      })
      const restart = Context.get(context, SessionRestart.Service)
      yield* bus.project(SessionEvent.Execution.Failed, (event) => Effect.sync(() => void failures.push(event)))

      yield* restart.resumeSuspendedSessions
      expect(drained).toEqual([])
      expect(failures.map((event) => event.data.error.type)).toEqual(["aborted"])
      // The terminal released the claim and reset the counter atomically.
      expect(yield* claims(database)).toEqual({ [sessionID]: false })
      expect(yield* attempts(database, sessionID)).toBe(0)
    }),
  )

  it.effect("counts every resume durably and never consumes the claim it recovers", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_resume_counted")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })

      const draining = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      // The drain never terminalizes (mirrors a process that will die mid-turn).
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const restart = Context.get(context, SessionRestart.Service)
      yield* restart.resumeSuspendedSessions.pipe(Effect.forkIn(scope))
      yield* Deferred.await(draining)

      // The attempt is durable before the drain runs, and the claim is held
      // throughout: a crash anywhere in the resume path leaves both intact.
      expect(yield* attempts(database, sessionID)).toBe(1)
      expect((yield* claims(database))[sessionID]).toBe(true)

      // Teardown (a graceful shutdown's interrupt) preserves both, so the next
      // boot counts attempt 2 against the same turn.
      yield* Scope.close(scope, Exit.void)
      expect((yield* claims(database))[sessionID]).toBe(true)
      expect(yield* attempts(database, sessionID)).toBe(1)
    }),
  )

  it.effect("the sweep leaves Sessions already draining in this process untouched", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const sessionID = Session.ID.make("ses_resume_local_active")
      yield* seedSessions(database, [sessionID])

      const draining = yield* Deferred.make<void>()
      const continued: SessionEvent.Synthetic[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)
      yield* bus.project(SessionEvent.Synthetic, (event) => Effect.sync(() => void continued.push(event)))

      // A live local turn holds a claim; the sweep must not count, continue, or terminalize it.
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)
      yield* restart.resumeSuspendedSessions

      expect(continued).toEqual([])
      expect(yield* attempts(database, sessionID)).toBe(0)
      expect((yield* claims(database))[sessionID]).toBe(true)
    }),
  )
})

// The recovery budget counts recovered turns that became runnable. A boot that finds the turn's Step held is only a
// wait: it is charged nothing, and its run is charged once, as it leaves the wait (SessionRunner `onRunnable`).
// Every ordering of up to three boots, on the real SessionRestart sweep, SessionExecution and store, with a scripted
// runner standing in for what each recovered run did before its host shut down:
//   wait     the run only waited out its hold;
//   cross    the run left the wait (or was runnable already) and stopped before writing its attempt ahead;
//   attempt  as cross, then the Step's attempt was written ahead, so the record has no hold;
//   hold     as cross, then the Step was held again (a new hold recorded).
// A hold that already ended at boot is recovered the same way: the hold's presence decides, not the clock.
describe("SessionRestart recovery budget across a held Step", () => {
  const CAP = 2
  type Action = "wait" | "cross" | "attempt" | "hold"
  const actions: ReadonlyArray<Action> = ["wait", "cross", "attempt", "hold"]
  const sequences = (length: number): Action[][] =>
    length === 0 ? [[]] : sequences(length - 1).flatMap((prefix) => actions.map((action) => [...prefix, action]))

  interface Boot {
    /** The boot called the runner, and with a deferred charge. */
    readonly drained: boolean
    readonly deferred: boolean
    readonly attempts: number
    readonly claimed: boolean
    readonly failures: number
  }
  // The model: a runnable claim is charged at boot; a waiting one when its run crosses. A charge past the cap fails
  // the turn (at boot, before any run; at a crossing, through the run), releasing the claim and resetting the count.
  const expected = (script: ReadonlyArray<Action>) => {
    const boots: Boot[] = []
    let held = true
    let attempts = 0
    let failures = 0
    let done = false
    for (const action of script) {
      if (done) {
        boots.push({ drained: false, deferred: false, attempts: 0, claimed: false, failures })
        continue
      }
      const deferred = held
      if (!deferred) attempts++
      if (!deferred && attempts > CAP) {
        failures++
        done = true
        boots.push({ drained: false, deferred, attempts: 0, claimed: false, failures })
        continue
      }
      if (deferred && action !== "wait") attempts++
      if (deferred && attempts > CAP) {
        failures++
        done = true
        boots.push({ drained: true, deferred, attempts: 0, claimed: false, failures })
        continue
      }
      if (action === "attempt") held = false
      if (action === "hold") held = true
      boots.push({ drained: true, deferred, attempts, claimed: true, failures })
    }
    return boots
  }

  const model = { id: ID.make("fake-model"), providerID: Provider.ID.make("fake") }
  const record = (until: number): SessionStepRoute.Record => ({
    next: { id: "step_held", attempt: 2 },
    message: SessionMessage.ID.create(),
    holds: 1,
    hold: { until, reason: "held", model, agent: Agent.ID.make("build") },
  })
  // An attempt written ahead: the Step is runnable, its last attempt possibly sent.
  const written: SessionStepRoute.Record = {
    next: { id: "step_held", attempt: 3, previous: { model, sent: true } },
    message: SessionMessage.ID.create(),
    holds: 1,
  }

  for (const expired of [false, true]) {
    it.effect(
      `charges a held turn's recovery once it becomes runnable, never at boot (hold ${expired ? "ended" : "active"} at boot)`,
      () =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const bus = yield* Bus.Service
          const store = yield* SessionStore.Service
          const failures: SessionEvent.Execution.Failed[] = []
          yield* bus.project(SessionEvent.Execution.Failed, (event) => Effect.sync(() => void failures.push(event)))
          const scripts = [1, 2, 3].flatMap(sequences).filter((script) => {
            // A run with no hold to wait on cannot only wait: drop scripts that would ask one to.
            let held = true
            for (const action of script) {
              if (action === "wait" && !held) return false
              if (action === "attempt") held = false
              if (action === "hold") held = true
            }
            return true
          })
          let index = 0
          for (const script of scripts) {
            const sessionID = Session.ID.make(`ses_held_budget_${expired ? "ended" : "active"}_${index++}`)
            yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })
            yield* SessionStepRoute.write(database.db, sessionID, record(Date.now() + (expired ? -1_000 : 60_000)))
            const observed: Boot[] = []
            for (const action of script) {
              const reached = yield* Deferred.make<boolean>()
              let drained = false
              let deferred = false
              const scope = yield* Scope.make()
              const context = yield* buildExecution(
                scope,
                (input) =>
                  Effect.gen(function* () {
                    if (input.sessionID !== sessionID)
                      return yield* Effect.die(`unexpected recovery of ${input.sessionID}`)
                    drained = true
                    deferred = input.onRunnable !== undefined
                    if (action !== "wait") {
                      const charged = yield* Effect.exit(input.onRunnable ?? Effect.void)
                      if (Exit.isFailure(charged)) {
                        yield* Deferred.succeed(reached, false)
                        return yield* charged
                      }
                      if (action === "attempt") yield* SessionStepRoute.write(database.db, sessionID, written)
                      if (action === "hold")
                        yield* SessionStepRoute.write(database.db, sessionID, record(Date.now() + 60_000))
                    }
                    yield* Deferred.succeed(reached, true)
                    return yield* Effect.never
                  }),
                { maxAttempts: CAP },
              )
              yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
              // A claim the sweep kept is recovered: its run reaches the scripted point (or fails its charge and settles).
              if ((yield* claims(database))[sessionID]) {
                const running = yield* Deferred.await(reached).pipe(Effect.timeout("5 seconds"), TestClock.withLive)
                if (!running) yield* Context.get(context, SessionExecution.Service).awaitIdle(sessionID)
              }
              // The host shuts down: a graceful teardown keeps the claim, as a restart finds it.
              yield* Scope.close(scope, Exit.void)
              observed.push({
                drained,
                deferred,
                attempts: (yield* attempts(database, sessionID)) ?? -1,
                claimed: (yield* claims(database))[sessionID] ?? false,
                failures: failures.filter((event) => event.data.sessionID === sessionID).length,
              })
            }
            expect({ script, boots: observed }).toEqual({ script, boots: expected(script) })
            // Settled, so the next script's boots recover only their own claim.
            yield* store.release(sessionID)
          }
          expect(failures.every((event) => event.data.error.type === "aborted")).toBe(true)
          expect(failures.length).toBeGreaterThan(0)
        }),
    )
  }

  it.effect("charges a held turn's recovery once however often its run reaches runnable work", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_held_budget_once")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })
      yield* SessionStepRoute.write(database.db, sessionID, record(Date.now() + 60_000))
      const charged = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.gen(function* () {
          // A compaction ahead of the Step, a reload, then the Step itself: each reaches runnable work.
          yield* input.onRunnable ?? Effect.die("the held turn's run got no deferred charge")
          yield* input.onRunnable ?? Effect.void
          yield* input.onRunnable ?? Effect.void
          yield* Deferred.succeed(charged, undefined)
          return yield* Effect.never
        }),
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Deferred.await(charged)
      expect(yield* attempts(database, sessionID)).toBe(1)
      expect((yield* claims(database))[sessionID]).toBe(true)
    }),
  )
})

describe("SessionRestart background recovery", () => {
  it.effect("wakes idle shell owners with recovered notices exactly once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const jobs = yield* Job.Service
      const bus = yield* Bus.Service
      const parent = Session.ID.make("ses_background_recovery_parent")
      const child = Session.ID.make("ses_background_recovery_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      yield* seedBackground(jobs, parent, [
        { id: "sh_background_orphan", shellID: "sh_background_orphan", command: "sleep 60" },
      ])
      yield* seedBackground(jobs, child, [{ id: "call-child-shell", shellID: "sh_child_orphan", command: "sleep 30" }])

      expect(yield* store.listSuspended()).toEqual([])
      expect(yield* jobs.pendingBackground).toHaveLength(2)

      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(SessionInbox.promote(database.db, bus, sessionID, "steer")),
            Effect.asVoid,
          ),
        undefined,
        restarted,
      )
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      // Fork (RestartWake): each idle owner, the subagent child too, is woken with its notice, once.
      yield* restart.resumeSuspendedSessions
      yield* Effect.forEach([parent, child], execution.awaitIdle, { discard: true })
      expect(drained.toSorted()).toEqual([parent, child].toSorted())
      expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toMatchObject([
        {
          type: "synthetic",
          description: "sleep 60",
          text: expect.stringContaining("server restarted"),
          metadata: {
            source: "shell",
            jobID: "sh_background_orphan",
            shellID: "sh_background_orphan",
            state: "cancelled",
          },
        },
      ])
      expect((yield* store.context(child)).filter((message) => message.type === "synthetic")).toMatchObject([
        {
          type: "synthetic",
          metadata: {
            source: "shell",
            jobID: "call-child-shell",
            shellID: "sh_child_orphan",
            state: "cancelled",
          },
        },
      ])
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
      expect(yield* SessionInbox.list(database.db, child)).toEqual([])
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
      expect(yield* restarted.pendingBackground).toEqual([])

      yield* restart.resumeSuspendedSessions
      expect(drained).toHaveLength(2)
      expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toHaveLength(1)
      expect((yield* store.context(child)).filter((message) => message.type === "synthetic")).toHaveLength(1)
    }),
  )

  it.live("counts a suspended parent's restart attempt before its shell-woken child can wake it", () =>
    Effect.gen(function* () {
      const db = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_shell_wake_budget_parent")
      const child = Session.ID.make("ses_shell_wake_budget_child")
      yield* seedSessions(db, [parent], { time_suspended: Date.now(), resume_attempts: 1 })
      yield* seedSessions(db, [child], { parent_id: parent })
      const daemon = yield* daemonShells()
      const [finished, other] = yield* daemon.withShell("/project", (shell) =>
        Effect.all([
          shell.create({ shell: "/bin/sh", command: "finished", cwd: "/tmp" }),
          shell.create({ shell: "/bin/sh", command: "still running", cwd: "/tmp" }),
        ]),
      )
      yield* seedBackground(jobs, child, [{ id: finished.id, shellID: finished.id, command: "finished" }])
      yield* seedBackground(jobs, parent, [{ id: other.id, shellID: other.id, command: "still running" }])
      daemon.daemon.exit(1, 0)
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Scope.provide(scope))
      const shell = yield* daemon.openShell("/project").pipe(Scope.provide(scope))
      const store = yield* SessionStore.Service
      const firstRootDrain = yield* Deferred.make<number | undefined>()
      const bus = yield* Bus.Service
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.gen(function* () {
            yield* SessionInbox.promote(db.db, bus, sessionID, "steer")
            if (sessionID === parent) {
              yield* Deferred.succeed(firstRootDrain, yield* attempts(db, parent))
              return
            }
            const assistantMessageID = SessionMessage.ID.create()
            yield* bus.publish(SessionEvent.Step.Started, {
              sessionID,
              assistantMessageID,
              agent: Agent.ID.make("build"),
              model: { id: ID.make("fake-model"), providerID: Provider.ID.make("fake") },
              started: 0,
            })
            yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 1 })
            yield* bus.publish(SessionEvent.Text.Ended, {
              sessionID,
              assistantMessageID,
              ordinal: 1,
              text: "Shell done",
            })
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID,
              assistantMessageID,
              finish: "stop",
              cost: Money.USD.make(0),
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
          }),
        { maxAttempts: 2 },
        restarted,
        {
          ...shell,
          // If the finished shell already woke its child, let that drain settle mid-sweep.
          get: (id) =>
            id === other.id ? execution.awaitIdle(child).pipe(Effect.andThen(shell.get(id))) : shell.get(id),
        },
      )
      const execution: SessionExecution.Interface = Context.get(context, SessionExecution.Service)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      expect(yield* Deferred.await(firstRootDrain)).toBe(2)
      yield* execution.awaitIdle(child)
      yield* execution.awaitIdle(parent)
      expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toMatchObject([
        { metadata: { notice: "restart" } },
        { metadata: { source: "subagent", childID: child } },
      ])
    }),
  )

  it.live("watches shell jobs whose commands survived the restart", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const jobs = yield* Job.Service
      const bus = yield* Bus.Service
      const parent = Session.ID.make("ses_background_shell_survived")
      yield* seedSessions(database, [parent])
      const daemon = yield* daemonShells()
      const before = yield* daemon.withShell("/project", (shell) =>
        Effect.gen(function* () {
          const running = yield* shell.create({ shell: "/bin/sh", command: "running", cwd: "/tmp" })
          const finished = yield* shell.create({ shell: "/bin/sh", command: "finished", cwd: "/tmp" })
          return { running, finished }
        }),
      )
      yield* seedBackground(jobs, parent, [
        { id: before.running.id, shellID: before.running.id, command: "running" },
        { id: before.finished.id, shellID: before.finished.id, command: "finished" },
      ])
      // The finished command ended while no server watched it.
      daemon.daemon.output(2, "done\n")
      daemon.daemon.exit(2, 0)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const shell = yield* daemon.openShell("/project").pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) => SessionInbox.promote(database.db, bus, sessionID, "steer").pipe(Effect.asVoid),
        undefined,
        restarted,
        shell,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

      const notices = Effect.gen(function* () {
        return (yield* store.context(parent)).filter(
          (message) => message.type === "synthetic" && message.metadata?.source === "shell",
        )
      })
      while ((yield* notices).length < 1) yield* Effect.sleep(5)
      expect(yield* notices).toMatchObject([
        {
          text: expect.stringContaining("done"),
          metadata: { source: "shell", shellID: before.finished.id, state: "completed", exit: 0 },
        },
      ])
      expect((yield* restarted.get(before.running.id))?.status).toBe("running")
      expect((yield* restarted.pendingBackground).map((item) => item.id)).toEqual([before.running.id])

      daemon.daemon.exit(1, 2)
      while ((yield* notices).length < 2) yield* Effect.sleep(5)
      expect((yield* notices)[1]).toMatchObject({
        text: expect.stringContaining(`${before.running.id} · exited 2`),
        metadata: { source: "shell", shellID: before.running.id, state: "completed", exit: 2 },
      })
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.live("settles a shell call a killed server left running as moved to the background", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const bus = yield* Bus.Service
      const parent = Session.ID.make("ses_background_shell_killed")
      yield* seedSessions(database, [parent], { time_suspended: Date.now() })
      const assistantMessageID = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: parent,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model: { id: ID.make("fake-model"), providerID: Provider.ID.make("fake") },
        started: 0,
      })
      yield* bus.publish(SessionEvent.Tool.Input.Started, {
        sessionID: parent,
        assistantMessageID,
        id: "call-shell",
        name: "shell",
      })
      yield* bus.publish(SessionEvent.Tool.Called, {
        sessionID: parent,
        assistantMessageID,
        id: "call-shell",
        input: { command: "sleep 60" },
        executed: false,
      })
      const daemon = yield* daemonShells()
      const info = yield* daemon.withShell("/project", (shell) =>
        shell.create({
          shell: "/bin/sh",
          command: "sleep 60",
          cwd: "/tmp",
          timeout: 120_000,
          waited: true,
          toolCall: { sessionID: parent, assistantMessageID, callID: "call-shell" },
        }),
      )
      // A call waits on it, so its deadline is not kept: taking it over never times it out.
      expect(daemon.daemon.processes[0]?.pipe?.metadata).not.toHaveProperty("timeoutDeadline")

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const shell = yield* daemon.openShell("/project").pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) => SessionInbox.promote(database.db, bus, sessionID, "steer").pipe(Effect.asVoid),
        undefined,
        restarted,
        shell,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

      const [assistant] = (yield* store.context(parent)).filter((message) => message.type === "assistant")
      expect(assistant?.type === "assistant" ? assistant.content : []).toMatchObject([
        {
          type: "tool",
          id: "call-shell",
          state: {
            status: "completed",
            content: [
              {
                type: "text",
                text: expect.stringMatching(
                  new RegExp(`^${info.id} · running · .* · moved to the background when the server restarted$`),
                ),
              },
              {
                type: "text",
                text: expect.stringMatching(
                  new RegExp(
                    `^PID: ${info.pid}\\n\\nIt keeps running, and you will be notified when it ends\\..*Output is streaming to: ${info.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
                  ),
                ),
              },
            ],
          },
        },
      ])
      expect((yield* restarted.get(info.id))?.status).toBe("running")
      expect(daemon.signals(1)).toEqual([])

      daemon.daemon.exit(1, 0)
      const notices = Effect.gen(function* () {
        return (yield* store.context(parent)).filter(
          (message) => message.type === "synthetic" && message.metadata?.source === "shell",
        )
      })
      while ((yield* notices).length < 1) yield* Effect.sleep(5)
      expect((yield* notices)[0]).toMatchObject({ metadata: { source: "shell", shellID: info.id, state: "completed" } })
    }),
  )

  for (const exited of [false, true])
    it.live(
      `reattaches once a ${exited ? "finished" : "running"} shell a killed server backgrounded without settling its call`,
      () =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const store = yield* SessionStore.Service
          const bus = yield* Bus.Service
          const jobs = yield* Job.Service
          const parent = Session.ID.make(`ses_background_shell_unsettled_${exited}`)
          yield* seedSessions(database, [parent], { time_suspended: Date.now() })
          const assistantMessageID = yield* seedShellCall(bus, parent, "call-shell")
          const daemon = yield* daemonShells()
          const info = yield* daemon.withShell("/project", (shell) =>
            shell.create({
              shell: "/bin/sh",
              command: "work",
              cwd: "/tmp",
              waited: true,
              toolCall: { sessionID: parent, assistantMessageID, callID: "call-shell" },
            }),
          )
          // The old server persisted the background job, then died before the step recorded the call's result.
          yield* seedBackground(jobs, parent, [{ id: info.id, shellID: info.id, command: "work" }])
          const [row] = yield* jobs.pendingBackground
          if (exited) {
            daemon.daemon.output(1, "finished output\n")
            daemon.daemon.exit(1, 0)
          }

          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
          const shell = yield* daemon.openShell("/project").pipe(Effect.provideService(Scope.Scope, scope))
          const context = yield* buildExecution(
            scope,
            ({ sessionID }) => SessionInbox.promote(database.db, bus, sessionID, "steer").pipe(Effect.asVoid),
            undefined,
            restarted,
            shell,
          )
          yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

          expect(yield* shellCallState(store, parent)).toMatchObject({ status: "completed" })
          const notices = shellNotices(store, parent)
          // A finished command's result is admitted during recovery, before any session resumes.
          if (exited)
            expect((yield* SessionInbox.list(database.db, parent)).length + (yield* notices).length).toBeGreaterThan(0)
          if (!exited) {
            expect((yield* restarted.pendingBackground).map((item) => item.notificationID)).toEqual([
              row?.notificationID,
            ])
            daemon.daemon.exit(1, 0)
          }
          while ((yield* notices).length < 1) yield* Effect.sleep(5)
          yield* Effect.sleep(50)
          expect(yield* notices).toMatchObject([{ id: row?.notificationID, metadata: { shellID: info.id } }])
          if (exited) expect(yield* notices).toMatchObject([{ text: expect.stringContaining("finished output") }])
          expect(yield* restarted.pendingBackground).toEqual([])
        }),
    )

  it.live("settles a recovered child's unsettled shell call before the child resumes", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_background_shell_child_parent")
      const child = Session.ID.make("ses_background_shell_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now() })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Inspect recovery",
        },
        run: Effect.never,
      })
      yield* jobs.background(child)
      const assistantMessageID = yield* seedShellCall(bus, child, "call-child-shell")
      const daemon = yield* daemonShells()
      const info = yield* daemon.withShell("/project", (shell) =>
        shell.create({
          shell: "/bin/sh",
          command: "child work",
          cwd: "/tmp",
          waited: true,
          toolCall: { sessionID: child, assistantMessageID, callID: "call-child-shell" },
        }),
      )

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const shell = yield* daemon.openShell("/project").pipe(Effect.provideService(Scope.Scope, scope))
      const seen = yield* Deferred.make<unknown>()
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          sessionID === child
            ? shellCallState(store, child).pipe(Effect.flatMap((state) => Deferred.succeed(seen, state)))
            : Effect.void,
        undefined,
        restarted,
        shell,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      expect(yield* Deferred.await(seen).pipe(Effect.timeout("2 seconds"))).toMatchObject({ status: "completed" })
      expect((yield* restarted.get(info.id))?.status).toBe("running")
      // Cancelling a reattached job stops its command.
      yield* restarted.cancel(info.id)
      while (daemon.signals(1).length === 0) yield* Effect.sleep(5)
      expect(daemon.signals(1)).toEqual(["SIGTERM"])
    }),
  )

  it.effect("preserves locally running background work", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_background_existing_parent")
      yield* seedSessions(database, [parent])
      yield* seedBackground(jobs, parent, [{ id: "call-running-shell", shellID: "sh_running", command: "sleep 60" }])

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.void)
      const restart = Context.get(context, SessionRestart.Service)
      yield* restart.resumeSuspendedSessions

      expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toEqual([])
      expect(yield* jobs.get("call-running-shell")).toMatchObject({ status: "running" })
      expect(yield* jobs.pendingBackground).toHaveLength(1)
    }),
  )

  it.effect("wakes the owner for a silent shell failure persisted before its completion notification", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_background_completed_shell")
      yield* seedSessions(database, [sessionID])
      const complete = yield* Deferred.make<string>()
      yield* jobs.start({
        id: "call-completed-shell",
        type: "shell",
        recovery: {
          kind: "shell",
          sessionID,
          shellID: "sh_completed",
          command: "exit 7",
        },
        run: Deferred.await(complete),
      })
      yield* jobs.background("call-completed-shell")
      yield* Deferred.succeed(complete, "Exited with code 7")
      yield* jobs.wait({ id: "call-completed-shell" })

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const drained: Session.ID[] = []
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)),
        undefined,
        restarted,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Context.get(context, SessionExecution.Service).awaitIdle(sessionID)

      // Fork (RestartWake): the end notice the dead server owed wakes its owner, as it would have.
      expect(drained).toEqual([sessionID])
      const inbox = yield* SessionInbox.list(database.db, sessionID)
      expect(inbox).toMatchObject([
        {
          type: "synthetic",
          payload: {
            text: '<background-result kind="shell" id="call-completed-shell" state="completed" command="exit 7">\nExited with code 7\n</background-result>',
          },
        },
      ])
      expect(inbox[0]).toHaveProperty("payload.metadata", {
        source: "shell",
        jobID: "call-completed-shell",
        shellID: "sh_completed",
        state: "completed",
      })
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("delivers an image outcome persisted before its notification, and cancels one still running", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_background_image")
      yield* seedSessions(database, [sessionID])
      const recovery = (path: string) => ({ kind: "image" as const, sessionID, path, model: "test/painter" })
      yield* jobs.start({
        id: "image_done",
        type: "generate_image",
        recovery: recovery("/tmp/done.png"),
        run: Effect.succeed("Image request finished. Saved image: /tmp/done.png (test/painter)."),
      })
      yield* jobs.background("image_done")
      yield* jobs.wait({ id: "image_done" })
      yield* jobs.start({
        id: "image_running",
        type: "generate_image",
        recovery: recovery("/tmp/running.png"),
        run: Effect.never,
      })
      yield* jobs.background("image_running")

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(scope, () => Effect.void, undefined, restarted)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

      const inbox = yield* SessionInbox.list(database.db, sessionID)
      expect(inbox.map((item) => (item.type === "synthetic" ? item.payload.text : undefined)).toSorted()).toEqual([
        '<background-result kind="image" id="image_done" state="completed">\nImage request finished. Saved image: /tmp/done.png (test/painter).\n</background-result>',
        '<background-result kind="image" id="image_running" state="cancelled">\nImage request for /tmp/running.png was cancelled because the server restarted.\n</background-result>',
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.live("waits again for a running video after a restart, then saves it and delivers the notice", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_background_video")
      yield* seedSessions(database, [sessionID])
      const videoID = VideoID.create()
      yield* jobs.start({
        id: videoID,
        type: "generate_video",
        recovery: { kind: "video", sessionID, path: "/tmp/running.mp4", videoID },
        run: Effect.never,
      })
      yield* jobs.background(videoID)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const directory = (yield* tmpdirScoped("opencode-video-restart-")).path
      const storage = yield* Layer.buildWithScope(
        AppNodeBuilder.build(LayerNode.group([BlobStore.node, FSUtil.node]), [
          Global.node.replace(Global.layerWith({ data: directory, config: directory })),
        ]),
        scope,
      )
      const blob = yield* Context.get(storage, BlobStore.Service).write(Stream.make(Uint8Array.of(1, 2, 3)))
      // The video service resumed polling on its own; the tool's recovery only waits on the video ID.
      const waited: VideoID[] = []
      const videos = VideoGeneration.Service.of({
        start: () => Effect.die("a recovered video must not be submitted again"),
        get: () => Effect.die("unused"),
        wait: (id) => Effect.sync(() => waited.push(id)).pipe(Effect.as({ id, status: "completed", blobs: [blob] })),
        cancel: () => Effect.die("unused"),
      })
      const driver = Environment.makeMemoryDriver()
      const files = Environment.makeFiles(driver)
      const location = Layer.mergeAll(
        Layer.succeed(Environment.Service, Environment.make(Environment.localID, driver)),
        Layer.succeed(VideoGeneration.Service, videos),
        Layer.succeedContext(storage),
      )
      const context = yield* buildExecution(scope, () => Effect.void, undefined, restarted, undefined, location)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

      yield* restarted.wait({ id: videoID })
      const texts = yield* SessionInbox.list(database.db, sessionID).pipe(
        Effect.map((inbox) => inbox.map((item) => (item.type === "synthetic" ? item.payload.text : ""))),
        Effect.repeat({ until: (texts) => texts.length === 1, schedule: Schedule.spaced("5 millis") }),
        Effect.timeout("10 seconds"),
      )
      expect(texts).toEqual([
        `<background-result kind="video" id="${videoID}" state="completed">\nVideo request finished. Saved video: /tmp/running.mp4.\n</background-result>`,
      ])
      expect(waited).toEqual([videoID])
      expect((yield* files.read("/tmp/running.mp4")).bytes).toEqual(Uint8Array.of(1, 2, 3))
    }),
  )

  for (const delivered of [false, true]) {
    it.effect(`does not duplicate a shell notification already ${delivered ? "delivered" : "admitted"}`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const jobs = yield* Job.Service
        const sessions = yield* Session.Service
        const sessionID = Session.ID.make("ses_shell_notification_retry")
        yield* seedSessions(database, [sessionID])
        yield* seedBackground(jobs, sessionID, [
          { id: "call-shell-notified", shellID: "sh_notified", command: "echo done" },
        ])
        const background = (yield* jobs.pendingBackground)[0]
        if (!background) return yield* Effect.die("background record missing")
        yield* sessions.synthetic({
          id: background.notificationID,
          sessionID,
          text: "Command already completed",
          metadata: { source: "shell", shellID: "sh_notified", state: "completed" },
          resume: false,
        })
        if (delivered) yield* SessionInbox.promote(database.db, bus, sessionID, "steer")

        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
        const context = yield* buildExecution(scope, () => Effect.void, undefined, restarted)
        yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

        expect(yield* restarted.pendingBackground).toEqual([])
        expect(yield* SessionInbox.list(database.db, sessionID)).toHaveLength(delivered ? 0 : 1)
        yield* SessionInbox.promote(database.db, bus, sessionID, "steer")
        const messages = (yield* sessions.messages({ sessionID })).filter((message) => message.type !== "idle")
        expect(messages).toMatchObject([
          {
            id: background.notificationID,
            type: "synthetic",
            text: "Command already completed",
            metadata: { state: "completed" },
          },
        ])
      }),
    )
  }

  it.effect("acknowledges recovery markers when their owning session is deleted", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_background_deleted")
      yield* seedSessions(database, [sessionID])
      yield* seedBackground(jobs, sessionID, [{ id: "call-deleted-shell", shellID: "sh_deleted", command: "sleep 60" }])
      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(scope, () => Effect.void, undefined, restarted)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("delivers cancellation at the resumed parent's next step", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const store = yield* SessionStore.Service
      const bus = yield* Bus.Service
      const parent = Session.ID.make("ses_background_claimed_parent")
      yield* seedSessions(database, [parent], { time_suspended: Date.now() })
      yield* seedBackground(jobs, parent, [{ id: "call-claimed-shell", shellID: "sh_claimed", command: "sleep 60" }])

      const observed = yield* Deferred.make<string[]>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          SessionInbox.promote(database.db, bus, sessionID, "steer").pipe(
            Effect.andThen(store.context(sessionID)),
            Effect.orDie,
            Effect.flatMap((messages) =>
              Deferred.succeed(
                observed,
                messages.filter((message) => message.type === "synthetic").map((message) => message.text),
              ),
            ),
            Effect.asVoid,
          ),
        undefined,
        restarted,
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      expect(yield* Deferred.await(observed)).toEqual([
        "The server restarted while you were working. Continue from where you left off without repeating completed work.",
        expect.stringContaining("Command cancelled because the server restarted"),
      ])
      yield* execution.awaitIdle(parent)
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
      expect((yield* claims(database))[parent]).toBe(false)
    }),
  )

  it.effect("does not bypass a claimed owner's restart budget for a shell notice", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_shell_recovery_exhausted")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now(), resume_attempts: 2 })
      yield* seedBackground(jobs, sessionID, [
        { id: "call-exhausted-shell", shellID: "sh_exhausted", command: "sleep 60" },
      ])

      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Scope.provide(scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)),
        { maxAttempts: 2 },
        restarted,
      )
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* execution.awaitIdle(sessionID)

      expect(drained).toEqual([])
      expect(yield* claims(database)).toEqual({ [sessionID]: false })
      expect(yield* attempts(database, sessionID)).toBe(0)
      expect(yield* SessionInbox.list(database.db, sessionID)).toMatchObject([
        { payload: { metadata: { source: "shell", state: "cancelled" } } },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
      yield* restart.resumeSuspendedSessions
      expect(drained).toEqual([])
    }),
  )

  for (const shellFirst of [false, true]) {
    for (const resumeAttempts of [1, 2]) {
      it.effect(
        `recovers a child's shell ${shellFirst ? "before" : "after"} its job record without bypassing attempt ${resumeAttempts + 1}`,
        () =>
          Effect.gen(function* () {
            const database = yield* Database.Service
            const jobs = yield* Job.Service
            const bus = yield* Bus.Service
            const store = yield* SessionStore.Service
            const parent = Session.ID.make("ses_shell_child_parent")
            const child = Session.ID.make("ses_shell_child")
            yield* seedSessions(database, [parent])
            yield* seedSessions(database, [child], {
              parent_id: parent,
              time_suspended: Date.now(),
              resume_attempts: resumeAttempts,
            })
            const shell = seedBackground(jobs, child, [
              { id: "call-child-shell", shellID: "sh_child", command: "sleep 60" },
            ])
            if (shellFirst) yield* shell
            yield* jobs.start({
              id: child,
              type: "subagent",
              recovery: {
                kind: "subagent",
                parentSessionID: parent,
                childSessionID: child,
                agent: "explore",
                description: "Inspect recovery",
              },
              run: Effect.never,
            })
            yield* jobs.background(child)
            if (!shellFirst) yield* shell
            expect((yield* jobs.pendingBackground).map((job) => job.recovery.kind)).toEqual(
              shellFirst ? ["shell", "subagent"] : ["subagent", "shell"],
            )

            const observed = yield* Deferred.make<{ attempts: number | undefined; notices: string[] }>()
            const release = yield* Deferred.make<void>()
            const parentWoken = yield* Deferred.make<void>()
            const drained: Session.ID[] = []
            const scope = yield* Scope.make()
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
            const restarted = yield* Job.make.pipe(Scope.provide(scope))
            const context = yield* buildExecution(
              scope,
              ({ sessionID }) =>
                Effect.gen(function* () {
                  drained.push(sessionID)
                  yield* SessionInbox.promote(database.db, bus, sessionID, "steer")
                  if (sessionID === parent) {
                    yield* Deferred.succeed(parentWoken, undefined)
                    return
                  }
                  yield* Deferred.succeed(observed, {
                    attempts: yield* attempts(database, sessionID),
                    notices: (yield* store.context(sessionID))
                      .filter((message) => message.type === "synthetic")
                      .map((message) => message.text),
                  })
                  yield* Deferred.await(release)
                }),
              { maxAttempts: 2 },
              restarted,
            )
            const restart = Context.get(context, SessionRestart.Service)
            const execution = Context.get(context, SessionExecution.Service)
            yield* restart.resumeSuspendedSessions

            if (resumeAttempts < 2) {
              expect(yield* Deferred.await(observed)).toEqual({
                attempts: 2,
                notices: [
                  expect.stringContaining("The server restarted while you were working"),
                  expect.stringContaining("Command cancelled because the server restarted"),
                ],
              })
              expect(drained).toEqual([child])
              expect(yield* execution.active).not.toContain(parent)
              expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
            }
            yield* Deferred.succeed(release, undefined)
            yield* Deferred.await(parentWoken)
            yield* Effect.forEach([parent, child], execution.awaitIdle, { discard: true })
            expect(drained).toEqual(resumeAttempts < 2 ? [child, parent] : [parent])
            expect((yield* store.context(parent)).filter((message) => message.type === "synthetic")).toMatchObject([
              { metadata: { source: "subagent", childID: child, state: resumeAttempts < 2 ? "completed" : "error" } },
            ])
            expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
            expect(yield* attempts(database, child)).toBe(0)
            expect(yield* restarted.pendingBackground).toEqual([])

            yield* restart.resumeSuspendedSessions
            expect(drained).toHaveLength(resumeAttempts < 2 ? 2 : 1)
          }),
      )
    }
  }

  it.effect("resumes a background subagent and notifies its parent exactly once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_subagent_recovery_parent")
      const child = Session.ID.make("ses_subagent_recovery_child")
      const unrelated = Session.ID.make("ses_subagent_unrelated_child")
      yield* seedSessions(database, [parent], { time_suspended: Date.now(), resume_attempts: 1 })
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now() })
      yield* seedSessions(database, [unrelated], { parent_id: parent })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Inspect recovery",
        },
        run: Effect.never,
      })
      yield* jobs.background(child)

      const resumed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const parentResumed = yield* Deferred.make<void>()
      const parentWoken = yield* Deferred.make<void>()
      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.gen(function* () {
            drained.push(sessionID)
            if (sessionID === child) {
              yield* Deferred.succeed(resumed, undefined)
              yield* Deferred.await(release)
              return
            }
            yield* Deferred.succeed(
              drained.filter((id) => id === parent).length === 1 ? parentResumed : parentWoken,
              undefined,
            )
          }),
        undefined,
        restarted,
      )
      const restart = Context.get(context, SessionRestart.Service)
      const execution = Context.get(context, SessionExecution.Service)
      yield* restart.resumeSuspendedSessions
      yield* Deferred.await(resumed)
      yield* Deferred.await(parentResumed)
      yield* execution.awaitIdle(parent)

      yield* restart.resumeSuspendedSessions
      expect(drained.toSorted()).toEqual([child, parent].toSorted())
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: true, [unrelated]: false })
      expect(yield* attempts(database, child)).toBe(1)
      expect(yield* restarted.get(child)).toMatchObject({ status: "running" })

      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(parentWoken)
      expect(drained.filter((id) => id === child)).toHaveLength(1)
      expect(drained.filter((id) => id === parent)).toHaveLength(2)
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        {
          payload: {
            description: "Inspect recovery",
            metadata: { source: "subagent", childID: child, agent: "explore", state: "completed" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
      yield* restart.resumeSuspendedSessions
      expect(yield* SessionInbox.list(database.db, parent)).toHaveLength(1)
    }),
  )

  it.effect("delivers a subagent result persisted before restart without rerunning the child", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_subagent_completed_parent")
      const child = Session.ID.make("ses_subagent_completed_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      const complete = yield* Deferred.make<string>()
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Completed inspection",
        },
        run: Deferred.await(complete),
      })
      yield* jobs.background(child)
      const output = "Example from the docs:\n\nBackground work still running:\n- shell (sh_1): bun test"
      yield* Deferred.succeed(complete, output)
      yield* jobs.wait({ id: child })

      const parentWoken = yield* Deferred.make<void>()
      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(Deferred.succeed(parentWoken, undefined)),
          ),
        undefined,
        restarted,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Deferred.await(parentWoken)

      expect(drained).toEqual([parent])
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        {
          payload: {
            text: `<background-result kind="subagent" sessionID="${child}" state="completed" description="Completed inspection">\n${output}\n</background-result>`,
            metadata: { state: "completed" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("delivers a completed outbox row at boot without touching the child", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_outbox_parent")
      const child = Session.ID.make("ses_outbox_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      yield* jobs.recordSubagentReport({
        notificationID: SessionMessage.ID.create(),
        status: "completed",
        output: "Started tests",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Outbox inspection",
          outstanding: [{ kind: "shell", sessionID: child, shellID: "sh_1", command: "bun test" }],
        },
      })

      const drained: Session.ID[] = []
      const parentWoken = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(Deferred.succeed(parentWoken, undefined)),
          ),
        undefined,
        restarted,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Deferred.await(parentWoken)

      // Replay uses the snapshot even though the shell is no longer running.
      expect(drained).toEqual([parent])
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        {
          type: "synthetic",
          payload: {
            text: `<background-result kind="subagent" sessionID="${child}" state="running" description="Outbox inspection">\nStarted tests\n\nBackground work still running:\n- shell (sh_1): bun test\n</background-result>`,
            metadata: { source: "subagent", childID: child, agent: "explore", state: "completed" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("wakes the parent of an admitted report if the restart sweep fails afterward", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const bus = yield* Bus.Service
      const parent = Session.ID.make("ses_failed_sweep_parent")
      const child = Session.ID.make("ses_failed_sweep_child")
      const root = Session.ID.make("ses_failed_sweep_root")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      yield* seedSessions(database, [root], { time_suspended: Date.now() })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Inspect",
        },
        background: true,
        run: Effect.succeed("Recovered result"),
      })
      yield* jobs.wait({ id: child })

      // The completed report is admitted before recovery publishes the unrelated root's restart notice.
      const failure = new Error("failed to project restart notice")
      yield* bus.project(SessionEvent.Synthetic, () => Effect.die(failure))
      const scope = yield* Scope.fork(yield* Effect.scope)
      const drained: Session.ID[] = []
      const context = yield* buildExecution(scope, ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)))
      const exit = yield* Effect.exit(Context.get(context, SessionRestart.Service).resumeSuspendedSessions)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
      expect(yield* jobs.pendingBackground).toEqual([])
      yield* Context.get(context, SessionExecution.Service).awaitIdle(parent)
      expect(drained).toEqual([parent])
    }),
  )

  it.effect("reconciles an outbox row whose notification was already delivered", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const sessions = yield* Session.Service
      const parent = Session.ID.make("ses_outbox_delivered_parent")
      const child = Session.ID.make("ses_outbox_delivered_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      const notificationID = SessionMessage.ID.create()
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Delivered inspection",
        },
        notificationID,
        background: true,
        run: Effect.succeed("Recovered result"),
      })
      yield* jobs.wait({ id: child })
      // Crash after delivery but before the outbox row was cleared.
      yield* sessions.synthetic({
        id: notificationID,
        sessionID: parent,
        text: "Original completion",
        resume: false,
      })
      yield* SessionInbox.promote(database.db, bus, parent, "steer")
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(scope, () => Effect.void, undefined, restarted)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

      expect(yield* restarted.pendingBackground).toEqual([])
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
      const messages = (yield* sessions.messages({ sessionID: parent })).filter((message) => message.type !== "idle")
      expect(messages).toMatchObject([{ id: notificationID, type: "synthetic", text: "Original completion" }])
    }),
  )

  it.effect("retains a subagent completion marker when synthetic admission conflicts", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const jobs = yield* Job.Service
      const sessions = yield* Session.Service
      const parent = Session.ID.make("ses_completion_conflict_parent")
      const child = Session.ID.make("ses_completion_conflict_child")
      const healthy = Session.ID.make("ses_completion_conflict_healthy")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent })
      yield* seedSessions(database, [healthy], { time_suspended: Date.now() })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Completed inspection",
        },
        run: Effect.succeed("Recovered result"),
      })
      yield* jobs.wait({ id: child })
      yield* jobs.background(child)
      const marker = (yield* jobs.pendingBackground)[0]
      if (!marker) return yield* Effect.die("background record missing")
      yield* admission.admit({
        id: marker.notificationID,
        sessionID: parent,
        item: { type: "user", payload: { text: "User input" }, delivery: "steer" },
      })

      const warnings: string[] = []
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(String(message))
      })
      const drained: Session.ID[] = []
      const healthyDrained = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        Effect.sync(() => void drained.push(sessionID)).pipe(
          Effect.andThen(sessionID === healthy ? Deferred.succeed(healthyDrained, undefined) : Effect.void),
        ),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const exit = yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions.pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.exit,
      )
      // The conflict is logged and its marker retained, but it never aborts the sweep.
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* Deferred.await(healthyDrained)
      yield* execution.awaitIdle(healthy)
      expect(drained).toEqual([healthy])
      expect((yield* claims(database))[healthy]).toBe(false)
      expect(warnings.join("\n")).toContain("Failed to admit recovered subagent notification due to ID conflict")
      expect(yield* jobs.pendingBackground).toEqual([marker])
      expect(yield* sessions.inbox(parent)).toMatchObject([{ type: "user", payload: { text: "User input" } }])
    }),
  )

  for (const resumeAttempts of [1, 2]) {
    it.effect(`honors a suspended parent's restart budget after ${resumeAttempts} attempts before notifying it`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const jobs = yield* Job.Service
        const parent = Session.ID.make("ses_subagent_budget_parent")
        const children = [
          Session.ID.make("ses_subagent_budget_child_1"),
          Session.ID.make("ses_subagent_budget_child_2"),
        ]
        yield* seedSessions(database, [parent], { time_suspended: Date.now(), resume_attempts: resumeAttempts })
        yield* seedSessions(database, children, { parent_id: parent })
        const complete = yield* Deferred.make<string>()
        for (const child of children) {
          yield* jobs.start({
            id: child,
            type: "subagent",
            recovery: {
              kind: "subagent",
              parentSessionID: parent,
              childSessionID: child,
              agent: "explore",
              description: "Completed inspection",
            },
            run: Deferred.await(complete),
          })
          yield* jobs.background(child)
        }
        yield* Deferred.succeed(complete, "Recovered result")
        yield* Effect.forEach(children, (id) => jobs.wait({ id }), { discard: true })

        const draining = yield* Deferred.make<number | undefined>()
        const release = yield* Deferred.make<void>()
        const drained: Session.ID[] = []
        const continued: Session.ID[] = []
        yield* bus.project(SessionEvent.Synthetic, (event) =>
          Effect.sync(() => void continued.push(event.data.sessionID)),
        )
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const restarted = yield* Job.make.pipe(Scope.provide(scope))
        const context = yield* buildExecution(
          scope,
          ({ sessionID }) =>
            Effect.gen(function* () {
              drained.push(sessionID)
              yield* Deferred.succeed(draining, yield* attempts(database, sessionID))
              yield* Deferred.await(release)
            }),
          { maxAttempts: 2 },
          restarted,
        )
        const restart = Context.get(context, SessionRestart.Service)
        const execution = Context.get(context, SessionExecution.Service)
        yield* restart.resumeSuspendedSessions

        if (resumeAttempts < 2) {
          expect(yield* Deferred.await(draining)).toBe(2)
          expect(drained).toEqual([parent])
          expect(continued).toEqual([parent])
          yield* Deferred.succeed(release, undefined)
          yield* execution.awaitIdle(parent)
        }
        if (resumeAttempts === 2) {
          expect(drained).toEqual([])
          expect(continued).toEqual([])
        }
        expect((yield* claims(database))[parent]).toBe(false)
        expect(yield* attempts(database, parent)).toBe(0)
        expect(yield* SessionInbox.list(database.db, parent)).toHaveLength(2)
        expect(yield* restarted.pendingBackground).toEqual([])
        yield* restart.resumeSuspendedSessions
        expect(drained).toHaveLength(resumeAttempts < 2 ? 1 : 0)
      }),
    )
  }

  it.effect("terminalizes a recovered subagent that exhausts its resume budget", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_subagent_exhausted_parent")
      const child = Session.ID.make("ses_subagent_exhausted_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now(), resume_attempts: 2 })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Exhausted inspection",
        },
        run: Effect.never,
      })
      yield* jobs.background(child)

      const parentWoken = yield* Deferred.make<void>()
      const drained: Session.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(Deferred.succeed(parentWoken, undefined)),
          ),
        { maxAttempts: 2 },
        restarted,
      )
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Deferred.await(parentWoken)

      expect(drained).toEqual([parent])
      expect((yield* claims(database))[child]).toBe(false)
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        {
          payload: {
            text: expect.stringContaining("will not be resumed automatically"),
            metadata: { source: "subagent", childID: child, state: "error" },
          },
        },
      ])
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )

  it.effect("charges a suspended parent's restart attempt before a fast child can wake it", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_restart_order_parent")
      const child = Session.ID.make("ses_restart_order_child")
      yield* seedSessions(database, [parent], { time_suspended: Date.now(), resume_attempts: 1 })
      yield* seedSessions(database, [child], { parent_id: parent, time_suspended: Date.now() })
      yield* jobs.start({
        id: child,
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: parent,
          childSessionID: child,
          agent: "explore",
          description: "Fast inspection",
        },
        background: true,
        run: Effect.never,
      })

      const trace: string[] = []
      yield* bus.project(SessionEvent.Synthetic, (event) =>
        Effect.sync(() => void trace.push(`continue:${event.data.sessionID}`)),
      )

      const childStarted = yield* Deferred.make<number | undefined>()
      const childSawParentContinue = yield* Deferred.make<boolean>()
      const gate = yield* Deferred.make<void>()
      let parentDrains = 0
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.gen(function* () {
            if (sessionID === child) {
              // The child settles immediately; it must already observe the parent's counted attempt.
              trace.push("child")
              yield* Deferred.succeed(childStarted, yield* attempts(database, parent))
              yield* Deferred.succeed(childSawParentContinue, trace.includes(`continue:${parent}`))
              return
            }
            parentDrains += 1
            yield* Deferred.await(gate)
          }),
        { maxAttempts: 2 },
        restarted,
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions

      expect(yield* Deferred.await(childStarted)).toBe(2)
      expect(yield* Deferred.await(childSawParentContinue)).toBe(true)
      expect(trace.indexOf(`continue:${parent}`)).toBeLessThan(trace.indexOf("child"))

      yield* Deferred.succeed(gate, undefined)
      yield* Effect.forEach([child, parent], execution.awaitIdle, { discard: true })
      expect(parentDrains).toBeGreaterThanOrEqual(1)
      // The report still arrives normally after the parent's own restart accounting.
      expect(yield* SessionInbox.list(database.db, parent)).toMatchObject([
        { payload: { metadata: { source: "subagent", childID: child, state: "completed" } } },
      ])
      expect(yield* claims(database)).toEqual({ [parent]: false, [child]: false })
      expect(yield* restarted.pendingBackground).toEqual([])
    }),
  )
})

describe("SessionExecution interrupt continuation", () => {
  it.effect("resumes only steering input after an interrupt with continue", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_continue_steer")
      yield* seedSessions(database, [sessionID])
      yield* seedInbox(database, sessionID, ["steer", "queue"])

      const draining = yield* Deferred.make<void>()
      const drains: Array<{ force: boolean; promotable?: SessionInbox.Promotable }> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.suspend(() => {
          drains.push({ force: input.force, promotable: input.promotable })
          if (drains.length > 1) return Effect.void
          return Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never))
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)

      yield* execution.interrupt(sessionID, { resume: true })
      yield* execution.awaitIdle(sessionID)

      // The successor drain is steer-scoped: queued next-turn work stays parked.
      expect(drains).toEqual([
        { force: true, promotable: "input" },
        { force: false, promotable: "steer" },
      ])
    }),
  )

  it.effect("stays parked after an interrupt with continue when only queued work remains", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_continue_parked")
      yield* seedSessions(database, [sessionID])
      yield* seedInbox(database, sessionID, ["queue"])

      const draining = yield* Deferred.make<void>()
      const drains: Array<SessionInbox.Promotable | undefined> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.suspend(() => {
          drains.push(input.promotable)
          return Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never))
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)

      yield* execution.interrupt(sessionID, { resume: true })
      yield* execution.awaitIdle(sessionID)

      expect(drains).toEqual(["input"])
      expect(yield* execution.active).toEqual(new Set())
    }),
  )

  it.effect("an idle interrupt with continue resumes pending steers", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_continue_idle")
      yield* seedSessions(database, [sessionID])
      yield* seedInbox(database, sessionID, ["steer"])

      const drains: Array<{ force: boolean; promotable?: SessionInbox.Promotable }> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.sync(() => void drains.push({ force: input.force, promotable: input.promotable })),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.interrupt(sessionID, { resume: true })
      yield* execution.awaitIdle(sessionID)

      expect(drains).toEqual([{ force: false, promotable: "steer" }])
    }),
  )

  it.effect("an interrupt with continue resumes a queued compaction next in line", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_continue_compaction")
      yield* seedSessions(database, [sessionID])
      yield* seedInbox(database, sessionID, [{ delivery: "queue", type: "compaction" }])

      const draining = yield* Deferred.make<void>()
      const drains: Array<{ force: boolean; promotable?: SessionInbox.Promotable }> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.suspend(() => {
          drains.push({ force: input.force, promotable: input.promotable })
          if (drains.length > 1) return Effect.void
          return Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never))
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)

      yield* execution.interrupt(sessionID, { resume: true })
      yield* execution.awaitIdle(sessionID)

      // Control work is housekeeping, not next-turn input: continue runs it.
      expect(drains).toEqual([
        { force: true, promotable: "input" },
        { force: false, promotable: "steer" },
      ])
    }),
  )

  it.effect("keeps a control item parked behind a queued prompt on continue", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_continue_control_behind")
      yield* seedSessions(database, [sessionID])
      yield* seedInbox(database, sessionID, ["queue", { delivery: "queue", type: "compaction" }])

      const drains: Array<{ force: boolean; promotable?: SessionInbox.Promotable }> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) =>
        Effect.sync(() => void drains.push({ force: input.force, promotable: input.promotable })),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.interrupt(sessionID, { resume: true })
      yield* execution.awaitIdle(sessionID)

      // The queued prompt is next in line; the compaction behind it waits its turn.
      expect(drains).toEqual([])
    }),
  )
})

// Fork feature (shell-restart-wake): a shell's end notice a restart recovers wakes its idle owner, exactly once.
describe("RestartWake: recovered shell notices wake their owner", () => {
  const MARK = "session.restart-wake:"
  const shellNotice = (sessionID: Session.ID, shellID: string) => ({
    sessionID,
    text: "Command cancelled because the server restarted",
    metadata: { source: "shell", shellID, state: "cancelled" },
    resume: false,
  })
  // A server after the restart: its own job registry over the same database, its drains recorded (and promoting the
  // Session's steer items, as a turn does), its sweep run.
  const boot = (drained: Session.ID[], drain?: (sessionID: Session.ID) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const scope = yield* Scope.make()
      const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
      const context = yield* buildExecution(
        scope,
        ({ sessionID }) =>
          Effect.sync(() => void drained.push(sessionID)).pipe(
            Effect.andThen(SessionInbox.promote(database.db, bus, sessionID, "steer")),
            Effect.andThen(drain?.(sessionID) ?? Effect.void),
            Effect.asVoid,
          ),
        undefined,
        restarted,
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      return { scope, execution, jobs: restarted }
    })
  const marks = KV.Service.use((kv) =>
    kv.scan({ prefix: MARK }).pipe(Effect.map((page) => page.entries.map((entry) => entry.key))),
  )

  // The sweep's own writes, cut short: the first boot's real sweep stops for good right after one of them (the server
  // died there, before any wake), and an independent boot on the resulting store must wake the owner once. Nothing
  // here writes the mark or the notice for the sweep.
  for (const crash of ["after writing its mark", "after completing its row"] as const)
    it.effect(`wakes the owner once when the sweep died ${crash}, before its wake`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const jobs = yield* Job.Service
        const kv = yield* KV.Service
        const store = yield* SessionStore.Service
        const sessionID = Session.ID.make("ses_restart_wake_crash")
        yield* seedSessions(database, [sessionID])
        yield* seedBackground(jobs, sessionID, [{ id: "sh_crash", shellID: "sh_crash", command: "sleep 60" }])

        const died = yield* Deferred.make<void>()
        const dead = Deferred.succeed(died, undefined).pipe(Effect.andThen(Effect.never))
        const firstScope = yield* Scope.make()
        const firstJobs = yield* Job.make.pipe(Effect.provideService(Scope.Scope, firstScope))
        const firstDrains: Session.ID[] = []
        const first = yield* buildExecution(
          firstScope,
          ({ sessionID }) => Effect.sync(() => void firstDrains.push(sessionID)),
          undefined,
          {
            ...firstJobs,
            completeBackground: (id) =>
              firstJobs
                .completeBackground(id)
                .pipe(Effect.andThen(crash === "after completing its row" ? dead : Effect.void)),
          },
          undefined,
          undefined,
          {
            ...kv,
            set: (key, value) =>
              kv
                .set(key, value)
                .pipe(Effect.andThen(crash === "after writing its mark" && key.startsWith(MARK) ? dead : Effect.void)),
          },
        )
        yield* Context.get(first, SessionRestart.Service).resumeSuspendedSessions.pipe(Effect.forkIn(firstScope))
        yield* Deferred.await(died)
        expect(yield* marks).toHaveLength(1)
        expect(yield* SessionInbox.list(database.db, sessionID)).toHaveLength(
          crash === "after writing its mark" ? 0 : 1,
        )

        const drained: Session.ID[] = []
        const second = yield* boot(drained)
        yield* second.execution.awaitIdle(sessionID)
        expect(firstDrains).toEqual([])
        expect(drained).toEqual([sessionID])
        expect(yield* SessionInbox.list(database.db, sessionID)).toEqual([])
        expect(yield* shellNotices(store, sessionID)).toHaveLength(1)
        expect(yield* second.jobs.pendingBackground).toEqual([])
        yield* Scope.close(second.scope, Exit.void)

        // A third boot: the notice was delivered, so nothing wakes and the mark is cleared.
        const third = yield* boot(drained)
        yield* third.execution.awaitIdle(sessionID)
        expect(drained).toEqual([sessionID])
        expect(yield* marks).toEqual([])
        expect(yield* shellNotices(store, sessionID)).toHaveLength(1)
        yield* Scope.close(third.scope, Exit.void)
        yield* Scope.close(firstScope, Exit.void)
      }),
    )

  // B1 (verifier 1122u): work the new server gives the owner while the sweep runs takes its last inbox look before
  // the recovered notice lands, and is still busy when the sweep ends. The owed notice is followed to the owner's idle.
  for (const tookIt of [false, true])
    it.effect(
      `delivers a notice admitted ${tookIt ? "before" : "after"} a busy owner's last inbox check once, ${tookIt ? "with no drain after" : "in a turn of its own once idle"}`,
      () =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const bus = yield* Bus.Service
          const jobs = yield* Job.Service
          const store = yield* SessionStore.Service
          const sessionID = Session.ID.make("ses_restart_wake_busy")
          yield* seedSessions(database, [sessionID])
          yield* seedBackground(jobs, sessionID, [{ id: "sh_busy", shellID: "sh_busy", command: "sleep 60" }])
          const scope = yield* Scope.make()
          const restarted = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope))
          const checked = yield* Deferred.make<void>()
          const settle = yield* Deferred.make<void>()
          const promoted: number[] = []
          const context = yield* buildExecution(
            scope,
            ({ sessionID }) =>
              Effect.gen(function* () {
                const first = promoted.length === 0
                // The turn's inbox check; the first turn may wait for the notice before it.
                if (first && tookIt) yield* Deferred.await(settle)
                const before = (yield* SessionInbox.list(database.db, sessionID)).length
                yield* SessionInbox.promote(database.db, bus, sessionID, "steer")
                promoted.push(before)
                if (first && !tookIt) {
                  yield* Deferred.succeed(checked, undefined)
                  yield* Deferred.await(settle)
                }
              }),
            undefined,
            restarted,
          )
          const execution = Context.get(context, SessionExecution.Service)
          yield* Context.get(context, Session.Service).synthetic({ sessionID, text: "new work" })
          if (!tookIt) yield* Deferred.await(checked)
          yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
          expect(yield* execution.isActive(sessionID)).toBe(true)
          yield* Deferred.succeed(settle, undefined)
          // The owed notice is followed: once the owner is idle with it undelivered, it is woken for it.
          for (let turn = 0; turn < 1_000 && (yield* marks).length > 0; turn++) {
            yield* execution.awaitIdle(sessionID)
            yield* Effect.yieldNow
          }
          yield* execution.awaitIdle(sessionID)
          expect(yield* marks).toEqual([])
          expect(yield* SessionInbox.list(database.db, sessionID)).toEqual([])
          expect(yield* shellNotices(store, sessionID)).toHaveLength(1)
          // Each drain's count of items it took: the work, then the notice in a turn of its own once idle; or both at
          // once, and no drain after.
          expect(promoted).toEqual(tookIt ? [2] : [1, 1])
          yield* Scope.close(scope, Exit.void)
        }),
    )

  it.effect("never wakes for a notice delivered before the server died, even with its row left behind", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const sessions = yield* Session.Service
      const store = yield* SessionStore.Service
      const sessionID = Session.ID.make("ses_restart_wake_delivered")
      yield* seedSessions(database, [sessionID])
      // The command ended and its live end notice was delivered (a turn took it), then the server died before the
      // row was completed.
      const complete = yield* Deferred.make<string>()
      yield* jobs.start({
        id: "sh_delivered",
        type: "shell",
        recovery: { kind: "shell", sessionID, shellID: "sh_delivered", command: "echo done" },
        run: Deferred.await(complete),
      })
      yield* jobs.background("sh_delivered")
      yield* Deferred.succeed(complete, "done")
      yield* jobs.wait({ id: "sh_delivered" })
      const background = (yield* jobs.pendingBackground)[0]
      if (!background) return yield* Effect.die("background record missing")
      yield* sessions.synthetic({ id: background.notificationID, ...shellNotice(sessionID, "sh_delivered") })
      yield* SessionInbox.promote(database.db, bus, sessionID, "steer")

      const drained: Session.ID[] = []
      const restarted = yield* boot(drained)
      yield* restarted.execution.awaitIdle(sessionID)
      expect(drained).toEqual([])
      expect(yield* restarted.jobs.pendingBackground).toEqual([])
      expect(yield* marks).toEqual([])
      expect(yield* shellNotices(store, sessionID)).toHaveLength(1)
      yield* Scope.close(restarted.scope, Exit.void)
    }),
  )

  it.effect("a restart during the woken turn resumes that turn and does not wake for the shell again", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const store = yield* SessionStore.Service
      const sessionID = Session.ID.make("ses_restart_wake_twice")
      yield* seedSessions(database, [sessionID])
      yield* seedBackground(jobs, sessionID, [{ id: "sh_twice", shellID: "sh_twice", command: "sleep 60" }])

      // The woken turn takes the notice, then the server dies under it (teardown keeps its claim).
      const drained: Session.ID[] = []
      const drains = (count: number) =>
        Effect.gen(function* () {
          while (drained.length < count) yield* Effect.yieldNow
        }).pipe(Effect.timeout("5 seconds"))
      const first = yield* boot(drained, () => Effect.never)
      yield* drains(1)
      yield* Scope.close(first.scope, Exit.void)
      expect(yield* claims(database)).toEqual({ [sessionID]: true })

      const second = yield* boot(drained)
      // The resumed turn starts from the sweep's own fiber.
      yield* drains(2)
      yield* second.execution.awaitIdle(sessionID)
      // One wake, one resume of the turn it started; one shell notice.
      expect(drained).toEqual([sessionID, sessionID])
      expect(yield* shellNotices(store, sessionID)).toHaveLength(1)
      expect(
        (yield* store.context(sessionID)).filter(
          (message) => message.type === "synthetic" && message.metadata?.notice === "restart",
        ),
      ).toHaveLength(1)
      expect(yield* claims(database)).toEqual({ [sessionID]: false })
      expect(yield* marks).toEqual([])
      yield* Scope.close(second.scope, Exit.void)
    }),
  )

  it.effect("does not wake an archived, stopped or deleted owner, and clears their marks", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const kv = yield* KV.Service
      const archived = Session.ID.make("ses_restart_wake_archived")
      const stopped = Session.ID.make("ses_restart_wake_stopped")
      const deleted = Session.ID.make("ses_restart_wake_deleted")
      yield* seedSessions(database, [archived, stopped, deleted])
      for (const sessionID of [archived, stopped, deleted])
        yield* seedBackground(jobs, sessionID, [
          { id: `sh_${sessionID}`, shellID: `sh_${sessionID}`, command: "sleep 60" },
        ])
      yield* database.db
        .update(SessionTable)
        .set({ time_archived: Date.now() })
        .where(eq(SessionTable.id, archived))
        .run()
        .pipe(Effect.orDie)
      yield* kv.set("session.stopped:" + stopped, true)
      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, deleted)).run().pipe(Effect.orDie)

      const drained: Session.ID[] = []
      const restarted = yield* boot(drained)
      yield* Effect.forEach([archived, stopped], restarted.execution.awaitIdle, { discard: true })
      expect(drained).toEqual([])
      expect(yield* restarted.jobs.pendingBackground).toEqual([])
      expect(yield* marks).toEqual([])
      // The archived and stopped owners still hold their notice for their next turn.
      expect(yield* SessionInbox.list(database.db, archived)).toHaveLength(1)
      expect(yield* SessionInbox.list(database.db, stopped)).toHaveLength(1)
      yield* Scope.close(restarted.scope, Exit.void)
    }),
  )

  it.effect("leaves every other recovered tool job's owner idle (upstream's resume: false)", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const image = Session.ID.make("ses_restart_wake_image")
      const video = Session.ID.make("ses_restart_wake_video")
      const codemode = Session.ID.make("ses_restart_wake_codemode")
      const shell = Session.ID.make("ses_restart_wake_shell")
      yield* seedSessions(database, [image, video, codemode, shell])
      const running = (id: string, type: string, recovery: Job.Recovery) =>
        jobs.start({ id, type, recovery, run: Effect.never }).pipe(Effect.andThen(jobs.background(id)))
      yield* running("image_lost", "experimental_image_generate", {
        kind: "image",
        sessionID: image,
        path: "/tmp/lost.png",
        model: "test/painter",
      })
      // The harness's Locations have no video service, so a running video is reported as lost too.
      yield* running("video_lost", "experimental_video_generate", {
        kind: "video",
        sessionID: video,
        path: "/tmp/lost.mp4",
        videoID: VideoID.create(),
      })
      yield* running("codemode_lost", "codemode", { kind: "codemode", sessionID: codemode, jobID: "codemode_lost" })
      yield* seedBackground(jobs, shell, [{ id: "sh_lost", shellID: "sh_lost", command: "sleep 60" }])

      const drained: Session.ID[] = []
      const restarted = yield* boot(drained)
      yield* Effect.forEach([image, video, codemode, shell], restarted.execution.awaitIdle, { discard: true })
      expect(drained).toEqual([shell])
      for (const sessionID of [image, video, codemode])
        expect(yield* SessionInbox.list(database.db, sessionID)).toMatchObject([
          { type: "synthetic", payload: { text: expect.stringContaining('state="cancelled"') } },
        ])
      expect(yield* restarted.jobs.pendingBackground).toEqual([])
      yield* Scope.close(restarted.scope, Exit.void)
    }),
  )

  it.effect("tells the agent what happened: the handle, when it started, and that nothing reran", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const store = yield* SessionStore.Service
      const sessionID = Session.ID.make("ses_restart_wake_text")
      yield* seedSessions(database, [sessionID])
      yield* seedBackground(jobs, sessionID, [{ id: "sh_text", shellID: "sh_text", command: "make build" }])

      const drained: Session.ID[] = []
      const restarted = yield* boot(drained)
      yield* restarted.execution.awaitIdle(sessionID)
      expect(
        (yield* shellNotices(store, sessionID)).map((message) => (message.type === "synthetic" ? message.text : "")),
      ).toEqual([
        expect.stringMatching(
          /^<background-result kind="shell" id="sh_text" state="cancelled" command="make build">\nsh_text · cancelled · started \S+ before this notice\nCommand cancelled because the server restarted \(a reboot, a crash or a service stop\), partway through; how long it ran before that is not known\. Nothing was rerun: check what it left behind, and run it again if it is still needed\.\n<\/background-result>$/,
        ),
      ])
      yield* Scope.close(restarted.scope, Exit.void)
    }),
  )
})

function seedBackground(
  jobs: Job.Interface,
  sessionID: Session.ID,
  background: ReadonlyArray<{ readonly id: string; readonly shellID: string; readonly command: string }>,
) {
  return Effect.forEach(
    background,
    (job) =>
      Effect.gen(function* () {
        yield* jobs.start({
          id: job.id,
          type: "shell",
          recovery: { kind: "shell", sessionID, shellID: job.shellID, command: job.command },
          run: Effect.never,
        })
        yield* jobs.background(job.id)
      }),
    { discard: true },
  )
}

/** Plain deliveries seed user prompts; objects seed control items. */
function seedInbox(
  database: Database.Service["Service"],
  sessionID: Session.ID,
  items: ReadonlyArray<
    SessionInbox.Delivery | { readonly delivery: SessionInbox.Delivery; readonly type: "compaction" }
  >,
) {
  return database.db
    .insert(SessionInboxTable)
    .values(
      items.map((item, index) => {
        const entry = typeof item === "string" ? { delivery: item, type: "user" as const } : item
        return {
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: entry.type,
          payload: entry.type === "user" ? { text: "queued prompt" } : SessionInbox.CompactionPayload.make({}),
          delivery: entry.delivery,
          enqueued_seq: index + 1,
        }
      }),
    )
    .run()
    .pipe(Effect.orDie)
}

function seedSessions(
  database: Database.Service["Service"],
  sessionIDs: ReadonlyArray<Session.ID>,
  values: Partial<Pick<typeof SessionTable.$inferInsert, "time_suspended" | "resume_attempts" | "parent_id">> = {},
) {
  return Effect.gen(function* () {
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values(
        sessionIDs.map((id) => ({
          id,
          project_id: Project.ID.global,
          slug: id,
          directory: "/project",
          title: id,
          version: "test",
          ...values,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

/**
 * A KV that runs one armed action right after the next read of a Session's stop mark, before that read returns: a
 * stop or a new task that lands just after the restart sweep looked at the mark.
 */
function raceOnMark(sessionID: Session.ID) {
  return Effect.gen(function* () {
    const kv = yield* KV.Service
    const fired = yield* Deferred.make<void>()
    const state: { action?: Effect.Effect<void> } = {}
    const get: KV.Interface["get"] = (key) =>
      kv.get(key).pipe(
        Effect.tap(() => {
          const action = state.action
          if (key !== "session.stopped:" + sessionID || action === undefined) return Effect.void
          state.action = undefined
          return action.pipe(Effect.andThen(Deferred.succeed(fired, undefined)))
        }),
      )
    return {
      kv: KV.Service.of({ ...kv, get }),
      arm: (action: Effect.Effect<void>) => void (state.action = action),
      fired: Deferred.await(fired),
    }
  })
}

function claims(database: Database.Service["Service"]) {
  return database.db
    .select({ id: SessionTable.id, claimed: SessionTable.time_suspended })
    .from(SessionTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.id, row.claimed !== null]))),
    )
}

function attempts(database: Database.Service["Service"], sessionID: Session.ID) {
  return database.db
    .select({ attempts: SessionTable.resume_attempts })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.attempts),
    )
}

/** Builds the local execution layer plus the restart actions against the test harness services. */
function buildExecution(
  scope: Scope.Closeable,
  drain: (input: Parameters<SessionRunner.Interface["drain"]>[0]) => Effect.Effect<void, SessionRunner.RunError>,
  options?: SessionRestart.Options,
  overrideJobs?: Job.Interface,
  shell?: Shell.Interface,
  // Extra Location services, such as those a recovered video job continues with.
  extra?: Layer.Layer<never>,
  kv?: KV.Interface,
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const jobs = overrideJobs ?? (yield* Job.Service)
    const sessions = yield* Session.Service
    const inbox = yield* SessionInbox.Service
    const sessionLayer = Layer.effect(
      Session.Service,
      Effect.gen(function* () {
        const execution = yield* SessionExecution.Service
        return Session.Service.of({
          ...sessions,
          synthetic: (input) =>
            sessions
              .synthetic({ ...input, resume: false })
              .pipe(Effect.tap(() => (input.resume === false ? Effect.void : execution.wake(input.sessionID)))),
        })
      }),
    )
    const runner = Layer.succeed(
      SessionRunner.Service,
      SessionRunner.Service.of({
        drain: (input) => drain(input).pipe(Effect.as(SessionRunner.DrainResult.Complete())),
      }),
    )
    const locations = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(
        () =>
          // The local execution test only needs the Session runner (and the Shell, if given) from the Location graph.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          Layer.mergeAll(
            runner,
            shell ? Layer.succeed(Shell.Service, shell) : Layer.empty,
            extra ?? Layer.empty,
          ) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      ),
    )
    return yield* Layer.buildWithScope(
      SessionRestart.layer(options).pipe(
        Layer.provideMerge(sessionLayer),
        Layer.provideMerge(Layer.fresh(SessionExecution.layer)),
        Layer.provide(Layer.succeed(Database.Service, database)),
        Layer.provide(Layer.succeed(Bus.Service, bus)),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(Layer.succeed(Job.Service, jobs)),
        Layer.provide(Layer.succeed(KV.Service, kv ?? (yield* KV.Service))),
        Layer.provide(
          Layer.succeed(
            Shell.Daemon,
            Shell.Daemon.of({
              at: () => Effect.die("the harness has no daemon registry"),
              watch: (effect) => effect.pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid),
              handoffPrepared: () => false,
            }),
          ),
        ),
        Layer.provide(Layer.succeed(SessionInbox.Service, inbox)),
        // Do not reuse the outer harness's selector with its already-captured Location map.
        Layer.provide(
          AppNodeBuilder.build(Instance.node, [LocationServiceMap.node.replace(locations)]).pipe(Layer.fresh),
        ),
      ),
      scope,
    )
  })
}

/** Records a shell call the model made that is still running, as a killed server leaves it. */
function seedShellCall(bus: Bus.Interface, sessionID: Session.ID, callID: string) {
  return Effect.gen(function* () {
    const assistantMessageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: { id: ID.make("fake-model"), providerID: Provider.ID.make("fake") },
      started: 0,
    })
    yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, id: callID, name: "shell" })
    yield* bus.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      id: callID,
      input: { command: "work" },
      executed: false,
    })
    return assistantMessageID
  })
}

function shellCallState(store: SessionStore.Interface, sessionID: Session.ID) {
  return store.context(sessionID).pipe(
    Effect.map((messages) =>
      messages.flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) => (part.type === "tool" ? [part.state] : []))
          : [],
      ),
    ),
    Effect.map((states) => states[0]),
  )
}

function shellNotices(store: SessionStore.Interface, sessionID: Session.ID) {
  return store
    .context(sessionID)
    .pipe(
      Effect.map((messages) =>
        messages.filter((message) => message.type === "synthetic" && message.metadata?.source === "shell"),
      ),
    )
}
