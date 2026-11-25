export * as SessionRunnerLLM from "./llm.js"

import { Message } from "@opencode/ai/effect"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Clock, Duration, Effect, Exit, FiberMap, Layer } from "effect"
import type { SessionRouteStep } from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { Environment } from "../../environment/index.js"
import { Flag } from "../../flag.js"
import { LocationLifecycle } from "../../location-lifecycle.js"
import { Environments } from "../../environment/environments.js"
import { SessionCwd } from "../cwd.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionBackground } from "../background.js"
import { Job } from "../../job.js"
import { SessionHistory } from "../history.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionStepRoute } from "../step-route.js"
import { SessionMessageTable } from "../sql.js"
import { SessionTitle } from "../title.js"
import { toSessionError } from "../to-session-error.js"
import { DrainResult, Service, type Interface } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionStep } from "./step.js"
import { PersistentPty } from "../../persistent-pty/index.js"
import { ToolOutput } from "../../tool-output.js"
import { Plugin } from "../../plugin.js"
import { PluginHooks } from "../../plugin/hooks.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"

const CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces."

// The shortest wait of a held Step, so a hook that holds or refuses with a past time cannot spin.
const HOLD_MIN_MS = 1_000

type DrainInput = Parameters<Interface["drain"]>[0]

/** Where a Step starts: a new one, or one a restart left unfinished (see SessionStepRoute). */
interface StepState {
  readonly route: SessionRouteStep
  readonly message: SessionMessage.ID
  readonly holds: number
}

/** Resolves where the next Step starts; a recovered waiting turn is charged its recovery as it leaves the wait. */
type Begin = Effect.Effect<StepState, StepFailedError>

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const inbox = yield* SessionInbox.Service
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const jobs = yield* Job.Service
    const title = yield* SessionTitle.Service
    const steps = yield* SessionStep.make
    const cwd = yield* SessionCwd.make
    const pty = yield* PersistentPty.Service
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    // Each drain is one turn and starts its own trace, whatever fiber woke it.
    const drain = Effect.fn("SessionRunner.drain", { root: true })(function* (input: DrainInput) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      let stepped = input.stepped ?? false
      const promotable = input.promotable ?? "input"
      // A recovered waiting turn charges its recovery budget as it leaves the wait (SessionRestart).
      const runnable = input.onRunnable ?? Effect.void
      // Input this drain starts on. A continuation carries none: it goes on with a turn already started.
      const pending = continuing || stepped ? undefined : yield* SessionInbox.nextPromotable(db, sessionID, "input")
      if (!force && !continuing && !stepped) {
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      // Before anything is delivered or loaded, so what a hook changes (the Session's model) holds for the whole turn.
      if (pending)
        yield* hooks.trigger("session", "experimental.wake", { sessionID }).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("wake hook failed", { sessionID, cause: Cause.pretty(cause) }),
          ),
        )
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")((begin: Begin) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({
                  force,
                  continuation: continuing ? { step } : undefined,
                  stepped: !continuing && stepped ? true : undefined,
                })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* inbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction") {
                    // A compaction is runnable work: a recovered waiting turn is charged before it is delivered.
                    yield* runnable
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [
                        SessionEvent.Compaction.Started,
                        { sessionID, reason: next.payload.reason ?? "manual", inputID: next.id },
                      ],
                    ])
                  }
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({
                  continuation: continuing ? { step } : undefined,
                  stepped: !continuing && stepped ? true : undefined,
                })
              if (pending?.type === "compaction") {
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    yield* plugins.awaitActivation
                    const selected = yield* context.select(sessionID)
                    const model = yield* context.resolveModel(selected.session, {
                      kind: "compaction",
                      agent: selected.agent.id,
                    })
                    // Preview updates without admitting them after the already-delivered compaction marker.
                    const history = yield* SessionHistory.preview(db, sessionID, selected.instructions, model.ref)
                    return yield* compaction.compact({
                      reason: "manual",
                      recorded: pending.payload.reason,
                      inputID: pending.id,
                      context: {
                        session: selected.session,
                        agent: selected.agent,
                        tools: selected.tools,
                        model,
                        initial: history.initial,
                        messages: history.messages,
                      },
                    })
                  }).pipe(
                    Effect.catch((error) =>
                      bus.publish(SessionEvent.Compaction.Failed, {
                        sessionID,
                        reason: pending.payload.reason ?? "manual",
                        inputID: pending.id,
                        error: toSessionError(error),
                      }),
                    ),
                  ),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: pending.payload.reason ?? "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer"))) {
                // Control-only drains such as a manual compaction never ran the model, so they skip the hook.
                if (pending || !stepped) return DrainResult.Complete()
                // The Session would go idle; a plugin may admit input to keep this execution working.
                yield* restore(
                  SessionBackground.outstanding(jobs, store, sessionID).pipe(
                    Effect.flatMap((background) =>
                      hooks.trigger("session", "experimental.idle", { sessionID, background }),
                    ),
                  ),
                )
                if (!(yield* SessionInbox.has(db, sessionID, "input"))) return DrainResult.Complete()
                continue
              }
              const ready = yield* restore(
                Effect.gen(function* () {
                  const state = yield* begin
                  const selected = yield* prepareContext(sessionID, state.route)
                  const promoted = yield* inbox.promote(
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                    hooks,
                  )
                  // A control admitted during context preparation owns this boundary.
                  if (promoted === undefined) return undefined
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) step = 1
                  // The Step loads its model and history itself, so a routing hold waits there, after delivery.
                  return { _tag: "Ready" as const, selection: selected, state }
                }),
              )
              if (ready) return ready
            }
          }),
        ),
      )

      // Only the drain's first Step can be one a shutdown or crash left unfinished.
      let first = true
      while (true) {
        let state: StepState | undefined
        // Resolved once per Step, as it is about to route: a Step the claim's record names continues as itself (same
        // routing id, send history and hold), and a held one first waits out its hold, before anything routes or
        // sends for it again. Any other Step is new; its routing identity doubles as its first assistant message.
        // The end of that wait is where a recovered waiting turn becomes runnable, so its recovery is charged there,
        // before anything routes.
        const begin = Effect.suspend(() => {
          if (state) return Effect.succeed(state)
          const recover = first
          first = false
          return (recover ? SessionStepRoute.read(db, sessionID) : Effect.succeed(undefined)).pipe(
            Effect.tap((resumed) => (resumed?.hold ? awaitHold(sessionID, resumed, resumed.hold) : Effect.void)),
            Effect.tap(() => runnable),
            Effect.map((resumed): StepState => {
              const stepID = SessionMessage.ID.create()
              return resumed
                ? {
                    route: resumed.next,
                    // A held Step's message is still empty; one an attempt may have written to stays as it is.
                    message: resumed.hold ? resumed.message : stepID,
                    holds: resumed.holds,
                  }
                : { route: { id: stepID, attempt: 1 }, message: stepID, holds: 0 }
            }),
            Effect.tap((resolved) => Effect.sync(() => (state = resolved))),
          )
        })
        const next = yield* advanceToStep(begin)
        if (next._tag !== "Ready") return next
        continuing = yield* runStep(next.selection, step, next.state, input.interruption)
        // Completed: the next Step routes on its own.
        yield* SessionStepRoute.clear(db, [sessionID])
        stepped = true
        step++
        force = false
        entering = false
      }
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (
      sessionID: SessionSchema.ID,
      route: SessionRouteStep,
    ) {
      // Plugins can reload mid-turn; each step and retry must read the settled agents, models and skills.
      yield* plugins.awaitActivation
      const selected = yield* context.select(sessionID, { step: route })
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    // The one host wait for a held Step: shown as the Step's retry state, interruptible. A Step recovered after a
    // restart waits out the rest of its hold here too, so its deadline outlives the process that set it.
    const awaitHold = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      state: Pick<StepState, "message" | "holds">,
      hold: NonNullable<SessionStepRoute.Record["hold"]>,
    ) {
      const now = yield* Clock.currentTimeMillis
      // A recovered hold that already ended has nothing left to show or wait for.
      if (hold.until <= now) return
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        agent: hold.agent,
        model: hold.model,
        assistantMessageID: state.message,
        started: now,
      })
      yield* bus.publish(SessionEvent.RetryScheduled, {
        sessionID,
        assistantMessageID: state.message,
        attempt: state.holds,
        at: hold.until,
        error: { type: "route.deferred", message: hold.reason },
      })
      if (hold.until > now) yield* Effect.sleep(Duration.millis(hold.until - now))
    })

    const runStep = Effect.fn("SessionRunner.runStep")(function* (
      first: SessionContext.Selection,
      step: number,
      state: StepState,
      interruption: DrainInput["interruption"],
    ) {
      const sessionID = first.session.id
      let assistantMessageID = state.message
      const retry = yield* SessionRunnerRetry.make(bus, sessionID)
      let initial: SessionContext.Selection | undefined = first
      let recoverOverflow = true
      let recoverContinuation = true
      let retryAttempt: number | undefined
      // Routing identity of this Step across holds, refusals, retries and restarts.
      let route = state.route
      let holds = state.holds
      // The model of the Step's last attempt that may have reached its provider. Sticky: a later hold, refusal or
      // routing decision never clears it, so every later attempt of the Step stays on that provider.
      let pinned = route.previous?.sent ? route.previous.model : undefined
      const reroute = (attempt?: { readonly model: Model.Ref; readonly sent: boolean }) => {
        if (attempt?.sent) pinned = attempt.model
        const previous = pinned ? { model: pinned, sent: true } : (attempt ?? route.previous)
        route = { id: route.id, attempt: route.attempt + 1, ...(previous ? { previous } : {}) }
      }
      const persist = (hold?: SessionStepRoute.Record["hold"]) =>
        SessionStepRoute.write(db, sessionID, {
          next: route,
          message: assistantMessageID,
          holds,
          ...(hold ? { hold } : {}),
        })
      let immediate = false
      // Holds the Step until `until` (at least HOLD_MIN_MS away), recorded before the wait so a restart honors it.
      const hold = Effect.fnUntraced(function* (input: {
        readonly agent: Agent.ID
        readonly model: Model.Ref
        readonly reason: string
        readonly until?: number
      }) {
        immediate = false
        const now = yield* Clock.currentTimeMillis
        const until = Math.ceil(Math.max(input.until ?? now, now + HOLD_MIN_MS))
        holds++
        const held = { until, reason: input.reason, model: input.model, agent: input.agent }
        yield* persist(held)
        yield* awaitHold(sessionID, { message: assistantMessageID, holds }, held)
      })
      while (true) {
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const selection = initial ?? (yield* prepareContext(sessionID, route))
        initial = undefined
        const routed = yield* context
          .load(selection)
          .pipe(
            Effect.catchTag("SessionRunnerModel.RouteDeferred", (held) =>
              Effect.succeed({ _tag: "Held" as const, held }),
            ),
          )
        if ("_tag" in routed) {
          // Nothing was attempted: the Step's send history (`previous`) carries over unchanged.
          reroute()
          yield* hold({
            agent: selection.agent.id,
            model: routed.held.model,
            reason: routed.held.reason,
            until: routed.held.until,
          })
          continue
        }
        const loaded = routed
        const estimate = SessionCompaction.estimatePrompt(loaded)
        const compacted = yield* compaction.compact({ reason: "auto", context: loaded, estimate })
        if (compacted.status === "failed") return yield* new StepFailedError({ error: compacted.error })
        if (compacted.status === "completed") {
          assistantMessageID = SessionMessage.ID.create()
          reroute()
          continue
        }
        yield* compaction.precompute(Effect.succeed(loaded), estimate)
        const stepLimitReached = loaded.agent.info.steps !== undefined && step >= loaded.agent.info.steps
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model: loaded.model,
          tools: loaded.tools,
          initial: loaded.initial,
          messages: loaded.messages,
        })
        const prepared = yield* context.request
          .primary({
            session: loaded.session,
            agent: loaded.agent.id,
            model: loaded.model,
            tools: loaded.tools,
            system: transcript.system,
            messages: stepLimitReached
              ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
              : transcript.messages,
            // Keep tool definitions on the final Step to preserve the provider's cached prefix.
            toolChoice: stepLimitReached ? "none" : undefined,
            webSocket: "session",
            inputTokens: estimate,
            step: route,
          })
          .pipe(
            // The hook event holds every message from before images are bounded, screenshots included, and is a separate
            // copy once a plugin hook has rewritten it. The step and its tool callbacks live as long as the slowest tool,
            // so they keep only what they use.
            Effect.map((prepared) => ({
              request: prepared.request,
              options: prepared.options,
              retry: prepared.retry,
              refused: prepared.refused,
              executeTool: prepared.executeTool,
            })),
          )
        const activeCwd = yield* cwd.current(sessionID)
        // Written ahead: until this attempt is known not sent, a restart treats it as possibly sent and pins its
        // provider for the rest of the Step.
        yield* SessionStepRoute.write(db, sessionID, {
          next: { id: route.id, attempt: route.attempt + 1, previous: { model: loaded.model.ref, sent: true } },
          message: assistantMessageID,
          holds,
        })
        const outcome = yield* steps
          .attempt({
            isLocationClosed: lifecycle.isClosed,
            interruption,
            handoffPrepared: pty.handoffPrepared,
            sessionID,
            assistantMessageID,
            agent: loaded.agent.id,
            model: loaded.model,
            prepared: {
              ...prepared,
              // A tool call can arrive during a reload; its permission check reads the session's agent.
              executeTool: (call) => plugins.awaitActivation.pipe(Effect.andThen(prepared.executeTool(call))),
            },
            retryAttempt,
            retry: (cause, error, proposed) =>
              retry.decide({
                cause,
                error,
                agent: loaded.agent.id,
                model: loaded.model.ref,
                hook: prepared.retry,
                retry: proposed,
              }),
            recoverContinuation,
            recoverOverflow: Effect.suspend(() =>
              recoverOverflow
                ? compaction
                    .compact({ reason: "overflow", context: loaded, estimate })
                    .pipe(Effect.map((result) => result.status === "completed"))
                : Effect.succeed(false),
            ),
          })
          .pipe(Effect.provideService(Environment.CurrentWorkingDirectory, activeCwd))
        retryAttempt = undefined
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: Effect.fnUntraced(function* (outcome) {
            // The Session is about to go idle, which leaves the background summary time to finish.
            if (!outcome.needsContinuation)
              yield* compaction.precompute(
                store.context(sessionID).pipe(Effect.map((messages) => ({ ...loaded, messages }))),
              )
            return outcome.needsContinuation
          }),
          Retry: Effect.fnUntraced(function* (outcome) {
            retryAttempt = outcome.decision.attempt
            yield* retry.wait({
              decision: outcome.decision,
              error: outcome.error,
              assistantMessageID,
            })
            if (outcome.freshAssistant) assistantMessageID = SessionMessage.ID.create()
            reroute({ model: loaded.model.ref, sent: true })
          }),
          Refused: Effect.fnUntraced(function* (outcome) {
            reroute({ model: loaded.model.ref, sent: false })
            // One immediate re-route per hold, so a refusing plugin cannot spin the Step.
            if (outcome.refusal.until !== undefined || immediate)
              return yield* hold({ agent: loaded.agent.id, model: loaded.model.ref, ...outcome.refusal })
            immediate = true
            // Known not sent: a restart from here may still route this Step anywhere its pin allows.
            yield* persist()
          }),
          OutputLimit: Effect.fn("SessionRunner.continueOutputLimit")(function* (outcome) {
            // The current response is included. User input or any other finish breaks the streak.
            const recent = yield* db
              .select({
                type: SessionMessageTable.type,
                finish: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.finish')`,
              })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, sessionID),
                  inArray(SessionMessageTable.type, ["user", "assistant"]),
                ),
              )
              .orderBy(desc(SessionMessageTable.seq))
              .limit(3)
              .all()
              .pipe(Effect.orDie)
            const exhausted =
              recent.length === 3 && recent.every((row) => row.type === "assistant" && row.finish === "length")
            if (exhausted)
              return yield* new StepFailedError({
                error: {
                  type: "output-limit",
                  message: "Response still truncated after two output token limit continuations",
                },
              })
            if (outcome.needsContinuation) return true
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_OUTPUT_LIMIT })
            assistantMessageID = SessionMessage.ID.create()
            reroute({ model: loaded.model.ref, sent: true })
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
            reroute({ model: loaded.model.ref, sent: true })
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
            reroute({ model: loaded.model.ref, sent: true })
          }),
        })
        if (completed !== undefined) return completed
      }
    })

    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* SessionHistory.incompleteAssistants(db, sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return Service.of({
      drain: (input) => drain(input).pipe(Effect.annotateSpans("session.id", input.sessionID)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    Environment.node,
    Flag.node,
    LocationLifecycle.node,
    Environments.node,
    llmClient,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionInbox.node,
    SessionCompaction.node,
    Plugin.node,
    PluginHooks.node,
    Job.node,
    SessionTitle.node,
    Snapshot.node,
    PersistentPty.node,
    ToolOutput.node,
    Database.node,
  ],
})
