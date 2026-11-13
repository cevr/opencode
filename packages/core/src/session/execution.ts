export * as SessionExecution from "./execution.js"

import { Cause, Context, Effect, Exit, Layer } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Job } from "../job.js"
import { Instance } from "../instance/service.js"
import { KV } from "../kv.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionEvent } from "./event.js"
import { SessionInbox } from "./inbox.js"
import { SubagentReport } from "./execution/subagent-report.js"
import { SessionRunCoordinator } from "./run-coordinator.js"
import { SessionRunner } from "./runner/index.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { toSessionError } from "./to-session-error.js"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Checks process-local ownership, including interruption cleanup and terminal settlement. */
  readonly isActive: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /**
   * Continues a turn a dead server left claimed (the restart sweep's resume). Unlike `resume` it is not new work:
   * it never ends a stop. A Session stopped when its turn's first drain begins (marked before the sweep looked, or
   * after) is never drained: the turn settles as the stop's user interruption, claim released and the stop's one
   * report given, and `recover` succeeds.
   */
  readonly recover: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Interrupt active work owned by this process. Idle interruption is a no-op. Resolves once
   * the interruption is accepted; cleanup settles asynchronously in the execution fiber.
   * Returns whether an active execution was interrupted. Compose with `awaitIdle` when
   * settlement matters.
   */
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: {
      readonly resume?: boolean
    },
  ) => Effect.Effect<boolean>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Stops the Session until it is given work again: marks it stopped (durably), cancels the background work it owns
   * (its shells, its own subagents' jobs; not its own subagent job), interrupts its active work and waits for that
   * to settle. A running subagent child settles as cancelled and reports that to its parent once. While stopped, a
   * notice admitted to it does not wake it, and a later period of it (its owner prompting it) reports nothing to its
   * parent. A `resume` (a parent's subagent tool giving it a new task) ends the stop. Returns whether active work was
   * interrupted. Queued input is the Session's to drop (`Session.stop`).
   */
  readonly stop: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Whether the Session was stopped and not resumed since. */
  readonly stopped: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

/** The KV key prefix of a stopped Session's mark. */
const STOPPED = "session.stopped:"

/** Routes execution from a Session ID to its selected instance's runner. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecution") {}

type InterruptReason = "user" | "shutdown"

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason) {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  return { type: "failed" as const, error: toSessionError(Cause.squash(exit.cause)) }
}

/**
 * Resumes after the event loop's next timer phase, past pending I/O: queued socket writes go out
 * first. A host timer, not the Clock, so a test clock never holds it.
 */
const nextTurn = Effect.callback<void>((resume) => {
  const timer = setTimeout(() => resume(Effect.void), 0)
  return Effect.sync(() => clearTimeout(timer))
})

/** Process-local execution: drains run in this process using the selected instance. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    const inbox = yield* SessionInbox.Service
    const db = (yield* Database.Service).db
    const kv = yield* KV.Service
    const stopped = (sessionID: SessionSchema.ID) =>
      kv.get(STOPPED + sessionID).pipe(Effect.map((mark) => mark !== undefined))
    const reportLifecycle = <A>(sessionID: SessionSchema.ID, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs({ sessionID }),
              ),
        ),
        Effect.asVoid,
      )
    // Write-ahead claim: starting records the durable intent that a turn is in flight, in the same
    // transaction as the started event. Terminals release it — except shutdown interruption, which
    // preserves the claim so the next server start resumes the turn. A claim that survives with no
    // terminal is the signature of a process that died without teardown (crash, SIGKILL, eviction);
    // recovery is a property of the database, never of a shutdown hook that may not run.
    const claimOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => store.claim(sessionID),
    })
    // The report coordinator is built first so the run coordinator's hooks can use it, while its
    // wake and draining dependencies bind late to the coordinator the hooks belong to.
    const holder: {
      coordinator?: SessionRunCoordinator.Coordinator<SessionSchema.ID, SessionRunner.RunError, InterruptReason>
    } = {}
    const subagentReport = SubagentReport.make({
      store,
      jobs,
      inbox,
      wake: (sessionID) =>
        Effect.suspend(() => (holder.coordinator ? holder.coordinator.wake(sessionID) : Effect.void)),
      draining: Effect.suspend<ReadonlySet<SessionSchema.ID>, never, never>(() =>
        holder.coordinator ? holder.coordinator.draining : Effect.succeed(new Set<SessionSchema.ID>()),
      ),
      stopped,
    })
    // Sessions a `recover` asked to run: their next run's first drain checks the stop mark before running the turn.
    const recovering = new Set<SessionSchema.ID>()
    // Why a Session's execution is being interrupted, read from the coordinator once it exists.
    let interruption: (sessionID: SessionSchema.ID) => InterruptReason | undefined = () => undefined
    const drain = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      force: boolean,
      continuation?: SessionRunner.Continuation,
      promotable: SessionInbox.Promotable = "input",
      stepped = false,
    ): Effect.fn.Return<void, SessionRunner.RunError> {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      const result = yield* SessionRunner.Service.use((runner) =>
        runner.drain({
          sessionID,
          force,
          continuation,
          promotable,
          stepped,
          interruption: () => interruption(sessionID),
        }),
      ).pipe(
        instances.provide(session),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )
      return yield* SessionRunner.DrainResult.$match(result, {
        Complete: () => Effect.void,
        Moved: (result) => drain(sessionID, false, result.continuation, promotable, result.stepped),
        Reloaded: (result) => drain(sessionID, result.force, result.continuation, promotable, result.stepped),
      })
    })
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError, InterruptReason>({
      started: (sessionID) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            // Bind before the started publication yields to SQLite so a cancel arriving during
            // that window still matches this generation.
            const before = yield* jobs.currentGeneration(sessionID)
            const event = yield* bus.publish(SessionEvent.Execution.Started, { sessionID }, claimOnCommit(sessionID))
            const bound = before?.running ? before : yield* jobs.currentGeneration(sessionID)
            subagentReport.started(sessionID, {
              startedSeq: event.durable.seq,
              boundGeneration: bound?.running ? bound.generation : undefined,
            })
          }),
        ),
      // A drain starts on the next turn of the event loop, not inside the wake: loading the history
      // and building the request is one long synchronous stretch (tens to hundreds of ms on a large
      // session), and the events and replies of what woke it (an answer's message, its form closing)
      // would otherwise reach their clients only after it.
      drain: (sessionID, force, promotable) =>
        nextTurn.pipe(
          Effect.andThen(
            Effect.gen(function* () {
              // A recovered turn reads the stop mark here, at its first drain, and not before its run starts:
              // a stop that lands before this read is seen, and one after it finds the turn active and
              // interrupts it. Either way the turn settles as the stop's user interruption, never drained.
              if (force && recovering.delete(sessionID) && (yield* stopped(sessionID))) {
                yield* Effect.suspend(() => holder.coordinator?.interrupt(sessionID, "user") ?? Effect.void)
                return yield* Effect.never
              }
              return yield* drain(sessionID, force, undefined, promotable)
            }),
          ),
        ),
      // One terminal observation per busy period, covering every coalesced drain.
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            const outcome = terminal(exit, reason)
            if (outcome.type === "interrupted" && outcome.reason === "shutdown") {
              subagentReport.clear(sessionID)
              // Shutdown keeps the claim and the running Job row for restart continuity.
              yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "shutdown" })
              return
            }
            // Claim the Job generation before cancelling it so the settlement commit owns its outbox row.
            const settlement = yield* subagentReport.prepare(sessionID, outcome)
            if (outcome.type === "interrupted") yield* jobs.cancel(sessionID)
            yield* publishTerminal(bus, sessionID, outcome, settlement.commit)
            // Post-commit delivery is best effort: a retained outbox marker is recovered on the
            // next restart, and a delivery defect must not fail the settled hook.
            yield* settlement.deliver.pipe(
              Effect.ignoreCause({ log: "Error", message: "Subagent report delivery failed" }),
            )
          }),
        ),
    })
    holder.coordinator = coordinator

    interruption = coordinator.interruption
    return Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      interrupt: (sessionID, options) =>
        Effect.gen(function* () {
          const interrupted = yield* coordinator.interrupt(sessionID, "user")
          if (!options?.resume) return interrupted
          // Resume steering input and between-turn control work from the interrupted
          // intent. Queued next-turn prompts stay parked: a steer-scoped drain never
          // promotes them, and a control item behind a queued prompt waits its turn.
          // Interruption acknowledges before cleanup settles, so this wake usually lands
          // on the stopping execution's doorbell and starts the successor at settle.
          // Reading the inbox concurrently with the dying drain is safe: delivery consumes
          // rows inside uninterruptible publications, so a steer row is either still
          // promotable here or was fully delivered and needs no resumption.
          const next = yield* SessionInbox.nextPromotable(db, sessionID, "input")
          if (next === undefined) return interrupted
          if (next.delivery === "steer" || next.type === "compaction" || next.type === "move")
            yield* coordinator.wake(sessionID, "steer")
          return interrupted
        }),
      // New work ends a stop: the mark goes before the run starts, so its period reports as any other.
      resume: (sessionID) => kv.remove(STOPPED + sessionID).pipe(Effect.andThen(coordinator.run(sessionID))),
      // Only a run's first drain consumes the flag (see `drain`). One left by a recover that joined a running
      // period is read by the next run's first drain, after a resume removed the mark or as the stop it is.
      recover: (sessionID) =>
        Effect.sync(() => void recovering.add(sessionID)).pipe(
          Effect.andThen(coordinator.run(sessionID)),
          // A stop that settled the recovered turn is its outcome, not an interruption of the caller.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.flatMap(stopped(sessionID), (mark) => (mark ? Effect.void : Effect.failCause(cause)))
              : Effect.failCause(cause),
          ),
        ),
      wake: coordinator.wake,
      awaitIdle: coordinator.awaitIdle,
      stop: (sessionID) =>
        Effect.gen(function* () {
          // Marked first: a notice its cancelled work admits, or a report of its own subagents, must not wake it.
          yield* kv.set(STOPPED + sessionID, true)
          yield* jobs.cancelOwned(sessionID)
          const interrupted = yield* coordinator.interrupt(sessionID, "user")
          yield* coordinator.awaitIdle(sessionID)
          return interrupted
        }),
      stopped,
    })
  }),
)

/** Publishes the terminal event with the settlement's atomic commit. */
function publishTerminal(
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  outcome: ReturnType<typeof terminal>,
  commit: (seq: number) => Effect.Effect<void>,
) {
  if (outcome.type === "succeeded") return bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, { commit })
  if (outcome.type === "interrupted") {
    return bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: outcome.reason }, { commit })
  }
  return bus.publish(SessionEvent.Execution.Failed, { sessionID, error: outcome.error }, { commit })
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, Instance.node, Bus.node, Database.node, Job.node, SessionInbox.node, KV.node],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    recover: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
    stop: () => Effect.succeed(false),
    stopped: () => Effect.succeed(false),
  }),
)
