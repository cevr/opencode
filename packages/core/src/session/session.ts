export * as Session from "./session.js"

import { DateTime, Effect, Fiber, Scope } from "effect"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Permission } from "@opencode/schema/permission"
import { Event } from "@opencode/schema/event"
import { FSUtil } from "@opencode/util/fs-util"
import { Bus } from "../bus.js"
import { isSqlError, type SqlError } from "effect/sql/SqlError"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { ShellResult } from "../shell/result.js"
import type { Skill } from "../skill.js"
import { SessionAdmission } from "./admission.js"
import { BusyError, CompactionConflictError, InboxConflictError, NotFoundError, PromptConflictError } from "./error.js"
import { SessionEvent } from "./event.js"
import { SessionExecution } from "./execution.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionPrompt } from "./prompt.js"
import { SessionRevert } from "./revert.js"
import { SessionShell } from "./shell.js"
import { SessionSkill } from "./skill.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { SessionSynthetic } from "./synthetic.js"

type PromptRequest = SessionPrompt.Input & {
  id?: SessionMessage.ID
  resume?: boolean
  /** Fork (synthetic-archived): set for a prompt that is not the user's own (SessionAdmission). */
  source?: SessionAdmission.Source
  /**
   * Fork (synthetic-archived): the selection its command's execute left pending (SessionAdmission.commandExtent),
   * published in this prompt's admitting transaction by switchAgent's and switchModel's rules.
   */
  select?: SessionAdmission.Selection
}

/**
 * Build once in the host Scope: `const sessions = yield* Session.make()`.
 * Use `sessions.forSession(id)` for handles that share host services and reload current state.
 */
export const make = Effect.fn("Session.make")(function* () {
  const bus = yield* Bus.Service
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const instances = yield* Instance.Service
  const execution = yield* SessionExecution.Service
  const admission = yield* SessionInbox.Service
  const fs = yield* FSUtil.Service
  const scope = yield* Scope.Scope

  const get = Effect.fn("Session.get")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (!session) return yield* new NotFoundError({ sessionID })
    return session
  })
  const message = Effect.fn("Session.message")(function* (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) {
    const stored = yield* store.message(messageID)
    return stored?.sessionID === sessionID ? stored.message : undefined
  })
  const view = Effect.fn("Session.view")(function* (sessionID: SessionSchema.ID, input: { idle: number }) {
    const session = yield* get(sessionID)
    if (
      session.time.idle === undefined ||
      input.idle > DateTime.toEpochMillis(session.time.idle) ||
      (session.time.viewed !== undefined && DateTime.toEpochMillis(session.time.viewed) >= input.idle)
    )
      return
    yield* bus.publish(SessionEvent.Viewed, { sessionID, idle: input.idle })
  })
  const rename = Effect.fn("Session.rename")(function* (sessionID: SessionSchema.ID, input: { title: string }) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.Renamed, { sessionID, title: input.title })
  })
  const archive = Effect.fn("Session.archive")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (session.time.archived) return
    yield* bus.publish(SessionEvent.Archived, { sessionID })
  })
  const unarchive = Effect.fn("Session.unarchive")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (!session.time.archived) return
    yield* bus.publish(SessionEvent.Unarchived, { sessionID })
  })
  const setMetadata = Effect.fn("Session.setMetadata")(function* (
    sessionID: SessionSchema.ID,
    input: { metadata: SessionSchema.Metadata },
  ) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.MetadataUpdated, { sessionID, metadata: input.metadata })
  })
  const setPermissions = Effect.fn("Session.setPermissions")(function* (
    sessionID: SessionSchema.ID,
    input: { permissions: Permission.Ruleset },
  ) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.Permissions, { sessionID, permissions: input.permissions })
  })
  const switchAgent = Effect.fn("Session.switchAgent")(function* (
    sessionID: SessionSchema.ID,
    input: { agent: Agent.ID },
  ) {
    const session = yield* get(sessionID)
    // Without a stored agent the Session runs as its Location's default, which its last step records.
    const current =
      session.agent ??
      (yield* store.lastAssistantAfter({ sessionID }).pipe(Effect.orElseSucceed(() => undefined)))?.agent
    if (current === input.agent) return
    yield* bus.publish(SessionEvent.AgentSelected, { sessionID, agent: input.agent, previous: session.agent })
  })
  const switchModel = Effect.fn("Session.switchModel")(function* (
    sessionID: SessionSchema.ID,
    input: { model: Model.Ref },
  ) {
    const session = yield* get(sessionID)
    if (
      session.model?.providerID === input.model.providerID &&
      session.model.id === input.model.id &&
      (session.model.variant ?? "default") === (input.model.variant ?? "default")
    )
      return
    yield* bus.publish(SessionEvent.ModelSelected, { sessionID, model: input.model, previous: session.model })
  })
  // Fork (synthetic-archived): one write transaction for a command's selection and what it is admitted with, holding
  // the session's publish lock first (so its own publishes inside need no other lock and are routed after the commit,
  // in order). A database failure is a defect, as a publish's is.
  const together = <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) =>
    Bus.exclusive(
      bus,
      sessionID,
    )(
      database.db
        .transaction(() => effect, { behavior: "immediate" })
        .pipe(Effect.catchIf((error): error is SqlError => isSqlError(error), Effect.die)),
    )
  // Fork (synthetic-archived): a command's pending selection, published as switchAgent and switchModel publish it, by
  // their rules and in that order, each its own event; then the selection's reactions (SessionAdmission.onSelection)
  // write theirs, before the input it is admitted with. Inside `together`.
  const applySelection = Effect.fnUntraced(function* (
    sessionID: SessionSchema.ID,
    select: SessionAdmission.Selection | undefined,
  ) {
    // Read inside the transaction: a concurrent command's selection, committed first, is the one this compares to.
    const session = yield* store.get(sessionID)
    if (!session) return
    const published: SessionAdmission.SelectionEvent[] = []
    const agent = select?.agent
    if (agent !== undefined) {
      const current =
        session.agent ??
        (yield* store.lastAssistantAfter({ sessionID: session.id }).pipe(Effect.orElseSucceed(() => undefined)))?.agent
      if (current !== agent)
        published.push(
          yield* bus.publish(SessionEvent.AgentSelected, { sessionID: session.id, agent, previous: session.agent }),
        )
    }
    const model = select?.model
    if (
      model !== undefined &&
      !(
        session.model?.providerID === model.providerID &&
        session.model.id === model.id &&
        (session.model.variant ?? "default") === (model.variant ?? "default")
      )
    )
      published.push(
        yield* bus.publish(SessionEvent.ModelSelected, { sessionID: session.id, model, previous: session.model }),
      )
    yield* SessionAdmission.react(session.location, published)
  })
  // Fork (synthetic-archived): a selection its command's execute made and no prompt carried, published when the
  // command returns, in one transaction checked under the admission's rule first: refused (archived, not the user's)
  // or deleted, nothing is selected.
  const select = Effect.fn("Session.select")(function* (
    sessionID: SessionSchema.ID,
    input: { readonly selection: SessionAdmission.Selection; readonly rule: SessionAdmission.Rule },
  ) {
    yield* together(
      sessionID,
      Effect.gen(function* () {
        yield* SessionAdmission.guard({ store, sessionID, rule: input.rule })
        yield* applySelection(sessionID, input.selection)
      }),
    ).pipe(
      Effect.catchDefect((defect) => (defect instanceof SessionAdmission.Refused ? Effect.void : Effect.die(defect))),
    )
  })
  const mutatePending = (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
    mutation: (input: {
      readonly id: SessionMessage.ID
      readonly sessionID: SessionSchema.ID
    }) => Effect.Effect<void, SessionInbox.LifecycleConflict>,
  ) =>
    mutation({ sessionID, id: inboxID }).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () =>
        Effect.gen(function* () {
          yield* get(sessionID)
          return yield* new InboxConflictError({ sessionID, inboxID })
        }),
      ),
    )

  const inbox = Effect.fn("Session.inbox")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    return yield* admission.list(sessionID)
  })
  const cancelInbox = Effect.fn("Session.cancelInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.cancel),
    Effect.uninterruptible,
  )
  const steerInbox = Effect.fn("Session.steerInbox")(function* (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
  ) {
    yield* mutatePending(sessionID, inboxID, admission.steer)
    yield* execution.wake(sessionID)
  }, Effect.uninterruptible)
  const queueInbox = Effect.fn("Session.queueInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.queue),
    Effect.uninterruptible,
  )
  const prompt = Effect.fn("Session.prompt")(
    (sessionID: SessionSchema.ID, input: PromptRequest, onAccepted?: Effect.Effect<void>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const session = yield* get(sessionID)
          const messageID = input.id ?? SessionMessage.ID.create()
          // Fork (synthetic-archived): a plugin's prompt is admitted under SessionAdmission's rule, decided in the
          // admitting transaction, which also commits a staged revert, so a refusal changes nothing; it is rung after
          // that commit. A user's prompt (no source) is upstream's.
          const source = input.source
          if (source && session.time.archived && SessionAdmission.rule(source) === "refuse")
            return yield* Effect.die(new SessionAdmission.Refused(sessionID, "archived"))
          const resume = input.resume !== false
          const decide = source
            ? SessionAdmission.commit({
                db: database.db,
                store,
                sessionID,
                inputID: messageID,
                rule: SessionAdmission.rule(source),
              })
            : undefined
          const admitted = yield* Effect.gen(function* () {
            const existing = yield* admission.reconcile({
              id: messageID,
              sessionID: session.id,
              type: "user",
              delivery: input.delivery ?? "steer",
            })
            if (existing) return existing
            // Preparation, the staged revert commit and admission share one acquisition of the session's location
            // services, so projections see its config whoever called prompt.
            return yield* Effect.gen(function* () {
              const item = yield* restore(SessionPrompt.prepare({ session, messageID, input }))
              // Commit a staged revert only after preparation succeeds, before admitting new work. Fork
              // (synthetic-archived): a sourced prompt, or one carrying a command's selection, writes the selection, its
              // reactions and then the revert's commit (upstream's order) in its admitting transaction (refused: none).
              const selecting = input.select?.agent !== undefined || input.select?.model !== undefined
              const atomic = decide !== undefined || selecting
              if (session.revert && !atomic) yield* SessionRevert.commit(bus, session)
              const revert: Bus.PublishInput[] =
                atomic && session.revert
                  ? [[SessionEvent.RevertEvent.Committed, { sessionID: session.id, to: session.revert.messageID }]]
                  : []
              const enqueue = admission.admit({
                id: messageID,
                sessionID: session.id,
                item,
                commit: decide,
                before: revert,
              })
              const admit = selecting
                ? together(sessionID, applySelection(sessionID, input.select).pipe(Effect.andThen(enqueue)))
                : enqueue
              return yield* source ? SessionAdmission.refused(store, sessionID, admit) : admit
            }).pipe(
              instances.provide(session),
              Effect.provideService(Database.Service, database),
              Effect.provideService(FSUtil.Service, fs),
            )
          }).pipe(
            Effect.catchTag("SessionInbox.LifecycleConflict", () => new PromptConflictError({ sessionID, messageID })),
          )
          if (source) {
            if (resume)
              yield* SessionAdmission.ring({
                db: database.db,
                store,
                sessionID,
                wake: execution.wake,
                inputID: messageID,
                rule: SessionAdmission.rule(source),
              })
          } else if (resume) yield* execution.wake(sessionID)
          // Checkpoint an accepted handoff before observing cancellation. Prompt preparation above stays interruptible.
          if (onAccepted) yield* onAccepted
          return admitted
        }),
      ),
  )
  const shell = Effect.fn("Session.shell")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; command: string },
  ) {
    const session = yield* get(sessionID)
    // The server owns completion recording even if the submitting client disconnects.
    const running = yield* Effect.gen(function* () {
      const started = yield* SessionShell.start({ session, command: input.command }).pipe(
        Effect.provideService(Instance.Service, instances),
        Effect.tapError((error) =>
          synthetic(sessionID, {
            text: `User shell command failed to start:\n${input.command}\n\n${error.message}`,
            description: input.command,
            metadata: { source: "shell", state: "error" },
            resume: false,
            source: "shell",
          }),
        ),
        Effect.orDie,
      )
      yield* bus.publish(
        SessionEvent.Shell.Started,
        {
          sessionID,
          shell: started.info,
        },
        { id: input.id ? Event.ID.make(input.id.replace(/^msg_/, "evt_")) : undefined },
      )
      const terminal = yield* started.result
      const preview = yield* started.output
      yield* bus.publish(SessionEvent.Shell.Ended, {
        sessionID,
        shell: terminal.info,
        output: preview,
      })
      yield* synthetic(sessionID, {
        ...ShellResult.userNotification(terminal),
        resume: false,
        source: "shell",
      }).pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.void),
        Effect.orDie,
      )
    }).pipe(Effect.forkIn(scope, { startImmediately: true }))
    yield* Fiber.join(running)
  })
  const skill = Effect.fn("Session.skill")(function* (
    sessionID: SessionSchema.ID,
    input: { messageID?: SessionMessage.ID; skill: Skill.ID; resume?: boolean },
  ) {
    const session = yield* get(sessionID)
    const skill = yield* SessionSkill.get({ session, skill: input.skill }).pipe(
      Effect.provideService(Instance.Service, instances),
    )
    yield* bus.publish(
      SessionEvent.Skill.Activated,
      {
        sessionID,
        id: skill.id,
        name: skill.name,
        text: skill.content,
      },
      { id: input.messageID ? Event.ID.make(input.messageID.replace(/^msg_/, "evt_")) : undefined },
    )
    if (input.resume !== false)
      yield* execution
        .resume(sessionID)
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
  })
  const compact = Effect.fn("Session.compact")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; delivery?: SessionInbox.Delivery; reason?: SessionMessage.CompactionReason },
  ) {
    const session = yield* get(sessionID)
    if (session.revert) yield* SessionRevert.commit(bus, session)
    const inputID = input.id ?? SessionMessage.ID.create()
    const admitted = yield* admission
      .admitCompaction({
        id: inputID,
        sessionID,
        delivery: input.delivery ?? "steer",
        reason: input.reason,
      })
      .pipe(
        Effect.catchTag("SessionInbox.LifecycleConflict", () => new CompactionConflictError({ sessionID, inputID })),
      )
    yield* execution.wake(sessionID)
    return admitted
  })
  const wait = Effect.fn("Session.wait")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    yield* execution.awaitIdle(sessionID)
  })
  const resume = Effect.fn("Session.resume")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    yield* execution.resume(sessionID)
  })
  // A stopped Session keeps a notice for its next task instead of running on it (SessionExecution.stop).
  const admitSynthetic = SessionSynthetic.make(
    store,
    admission,
    (sessionID) =>
      execution.stopped(sessionID).pipe(Effect.flatMap((held) => (held ? Effect.void : execution.wake(sessionID)))),
    database.db,
  )
  const synthetic = (sessionID: SessionSchema.ID, input: Omit<Parameters<typeof admitSynthetic>[0], "sessionID">) =>
    admitSynthetic({ ...input, sessionID })
  const interrupt = Effect.fn("Session.interrupt")(
    (sessionID: SessionSchema.ID, options?: { readonly resume?: boolean }) =>
      Effect.uninterruptible(execution.interrupt(sessionID, options)),
  )
  const stage = Effect.fn("Session.revert.stage")(function* (
    sessionID: SessionSchema.ID,
    input: { messageID: SessionMessage.ID; files?: boolean },
  ) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(Database.Service, database),
      Effect.provideService(Bus.Service, bus),
    )
  })
  const clear = Effect.fn("Session.revert.clear")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    yield* SessionRevert.clear(session).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(Bus.Service, bus),
    )
    return yield* execution.wake(sessionID)
  })
  const commit = Effect.fn("Session.revert.commit")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    return yield* SessionRevert.commit(bus, session)
  })
  const revert = { stage, clear, commit }
  const operations = {
    get,
    message,
    view,
    rename,
    archive,
    unarchive,
    setMetadata,
    setPermissions,
    switchAgent,
    switchModel,
    inbox,
    prompt,
    synthetic,
    shell,
    skill,
    compact,
    wait,
    resume,
    interrupt,
    cancelInbox,
    steerInbox,
    queueInbox,
    revert,
    select,
  }

  const forSession = (sessionID: SessionSchema.ID) => {
    const get = operations.get.bind(undefined, sessionID)
    const message = operations.message.bind(undefined, sessionID)
    const view = operations.view.bind(undefined, sessionID)
    const rename = operations.rename.bind(undefined, sessionID)
    const archive = operations.archive.bind(undefined, sessionID)
    const unarchive = operations.unarchive.bind(undefined, sessionID)
    const setMetadata = operations.setMetadata.bind(undefined, sessionID)
    const setPermissions = operations.setPermissions.bind(undefined, sessionID)
    const switchAgent = operations.switchAgent.bind(undefined, sessionID)
    const switchModel = operations.switchModel.bind(undefined, sessionID)
    const inbox = operations.inbox.bind(undefined, sessionID)
    const prompt = operations.prompt.bind(undefined, sessionID)
    const synthetic = operations.synthetic.bind(undefined, sessionID)
    const shell = operations.shell.bind(undefined, sessionID)
    const skill = operations.skill.bind(undefined, sessionID)
    const compact = operations.compact.bind(undefined, sessionID)
    const wait = operations.wait.bind(undefined, sessionID)
    const resume = operations.resume.bind(undefined, sessionID)
    const interrupt = operations.interrupt.bind(undefined, sessionID)
    const cancelInbox = operations.cancelInbox.bind(undefined, sessionID)
    const steerInbox = operations.steerInbox.bind(undefined, sessionID)
    const queueInbox = operations.queueInbox.bind(undefined, sessionID)
    const stage = operations.revert.stage.bind(undefined, sessionID)
    const clear = operations.revert.clear.bind(undefined, sessionID)
    const commit = operations.revert.commit.bind(undefined, sessionID)
    const revert = { stage, clear, commit }
    const select = operations.select.bind(undefined, sessionID)

    return {
      id: sessionID,
      get,
      message,
      view,
      rename,
      archive,
      unarchive,
      setMetadata,
      setPermissions,
      switchAgent,
      switchModel,
      inbox,
      prompt,
      synthetic,
      shell,
      skill,
      compact,
      wait,
      resume,
      interrupt,
      cancelInbox,
      steerInbox,
      queueInbox,
      revert,
      select,
    }
  }
  return { forSession }
})

export type Handle = ReturnType<Effect.Success<ReturnType<typeof make>>["forSession"]>

// Mirrors the shell tool's in-memory preview safety limit.
