export * as SessionAdmission from "./admission.js"

// Fork feature (synthetic-archived): what something other than the user's own prompt may put into a session, and when
// it may start a turn there. Upstream admits a plugin's or a tool's message into any session that exists and wakes it,
// so a session the user archived between a plugin's check and its admit received the message and ran a turn after its
// archive (measured on real OpenCode: leaf-review-tools round 3, window-probe).
//
// The rule, one decision for every non-user source:
// - it is taken inside the write transaction that admits the input (a `Bus.publish` commit hook, under SQLite's write
//   lock), so an archive or a delete commits either before the admit (and is seen) or after it (and the input was
//   admitted while the session was live);
// - the wake is rung only after that transaction committed, in a transaction of its own that re-reads the committed
//   row under the same rule (`ring`): a rolled-back admission rings nothing, and an archive that commits between the
//   admit and the ring is seen by the ring (the input is held then);
// - a refused call changes nothing: whatever it would write with its input (a staged revert's commit, a command's
//   agent or model selection) is written in the admitting transaction, and the refusal rolls it all back;
// - a deleted session refuses every source (typed NotFound);
// - an archived session refuses a source that keeps its input (typed ArchivedError, no row: the caller still holds it
//   and can give it again at the next prompt) and holds the input of one that does not (row admitted, no wake: the
//   next prompt's turn takes it once);
// - a reverted or stopped session admits and is not woken (upstream's rule for a revert, synthetic.ts's `revert`
//   check, and the fork's Session.stop rule), as before.
// Unarchiving wakes nothing: it publishes no work (session.ts `unarchive`).

import { and, eq, like, notExists, sql } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Event } from "@opencode/schema/event"
import { UserCommand } from "@opencode/util/effect/user-command"
import type { Database } from "../database/database.js"
import { KVTable } from "../kv/sql.js"
import { Location } from "../location.js"
import { NotFoundError } from "./error.js"
import { SessionInbox } from "./inbox.js"
import type { SessionMessage } from "./message.js"
import type { SessionEvent } from "./event.js"
import { SessionSchema } from "./schema.js"
import { SessionInboxTable } from "./sql.js"
import type { SessionStore } from "./store.js"

/**
 * Every source other than the user's own prompt that admits input into a session, and whether it keeps its input
 * when refused. `keeps: true` → an archived session refuses it; `keeps: false` → an archived session holds it. Every
 * admission call site in core and server names its source (`source: "<name>"`), is a plugin's (`ctx.session`, named
 * by the plugin host), or is counted in `Exempt`: `test/session-admission-sources.test.ts` fails on any other.
 */
export const Sources = {
  plugin: {
    keeps: true,
    why: "a plugin's ctx.session.synthetic or ctx.session.prompt: the plugin holds its input and is told",
  },
  http: {
    keeps: false,
    why:
      "a client's POST /api/session/:id/synthetic: the route cannot tell its callers apart (ACP's own turn context, which " +
      "the user's prompt after it takes, an SDK script, another client), so it holds; the response says `held: true`",
  },
  shell: {
    keeps: false,
    why: "a shell's end notice (the shell tool's background command, the user's ! command): its output has no other home",
  },
  job: {
    keeps: false,
    why: "a Code Mode script's background completion",
  },
  media: {
    keeps: false,
    why: "an image or video generation's result",
  },
  subagent: {
    keeps: false,
    why: "a subagent's report to its parent (live and at restart)",
  },
  restart: {
    keeps: false,
    why: "a notice the restart sweep recovers (a tool job the dead server left)",
  },
  background: {
    keeps: false,
    why: "the notice of the user's own request to background a session's blocking work",
  },
} as const

export type Source = keyof typeof Sources

/**
 * The admission call sites that name no source, counted per file (path from the repository root), each the user's own
 * input, an upstream path kept as is, the admission machinery itself, or no admission at all. A new call in any of
 * these files, or one anywhere else that names no source, fails the sources test until it is classified here or in
 * `Sources`.
 */
export const Exempt: Record<string, { readonly sites: number; readonly why: string }> = {
  "packages/server/src/handlers/session.ts": { sites: 1, why: "session.prompt: the user's own prompt over HTTP" },
  "packages/core/src/session.ts": { sites: 2, why: "the facade's prompt and synthetic forward their caller's input" },
  "packages/core/src/session/session.ts": {
    sites: 2,
    why: "prompt's own admission (its source, if any, decides there) and compaction (the user's /compact)",
  },
  "packages/core/src/session/synthetic.ts": { sites: 1, why: "synthetic's own admission, under its source's rule" },
  "packages/core/src/session/inbox.ts": { sites: 1, why: "admitCompaction's admission (the user's /compact)" },
  "packages/core/src/session/move.ts": { sites: 1, why: "the user's own move of the session to another location" },
  "packages/core/src/session/execution/subagent-report.ts": {
    sites: 1,
    why: 'a subagent\'s report, admitted through SessionAdmission.commit with rule("subagent") (`decide`)',
  },
  "packages/core/src/plugin/host.ts": {
    sites: 2,
    why: "a plugin's prompt and synthetic: source `plugin`, or none inside the user's own command (pluginSource)",
  },
  "packages/core/src/automation.ts": {
    sites: 3,
    why: "an automation's scheduled prompt: the user's standing instruction naming the session; upstream kept (owner question)",
  },
  "packages/core/src/tool/plugin/subagent.ts": {
    sites: 1,
    why: "the parent's turn prompting its own child (a deliberate act of a live, prompted parent); upstream kept",
  },
  "packages/core/src/config/plugin/command.ts": {
    sites: 1,
    why: "a subagent command's prompt to the child it just created for the user's command; upstream kept",
  },
  "packages/core/src/aisdk.ts": { sites: 1, why: "a model request's prompt field: no session admission" },
  "packages/core/src/codemode/instructions.ts": { sites: 1, why: "an instruction template: no session admission" },
}

/**
 * How an archived session answers an admission: `refuse` (a source that keeps its input), `hold` (one that does not),
 * or `user`: no source, the user's own input (a prompt, a slash command the user typed), admitted and woken as
 * upstream does. Every production call site names its source or is counted in `Exempt` (the sources test).
 */
export type Rule = "refuse" | "hold" | "user"

export const rule = (source: Source | undefined): Rule =>
  source === undefined ? "user" : Sources[source].keeps ? "refuse" : "hold"

/**
 * Runs the user's own slash command (`Session.command` called from the server's route, the user's entry): within its
 * execute's extent, a plugin's prompt or message to that session is the user's (the plugin host reads the mark). The
 * mark closes when the command returns, so work the command left running is a plugin's again.
 */
export const userCommand =
  (sessionID: SessionSchema.ID) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const mark: UserCommand.Mark = { sessionID, user: true, open: true }
      return effect.pipe(
        Effect.provideService(UserCommand.Current, mark),
        Effect.ensuring(Effect.sync(() => void (mark.open = false))),
      )
    })

/** A command a plugin invokes is not the user's, even from inside the user's own command. */
export const notUserCommand = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(UserCommand.Current, undefined))

/** The source of a plugin's input to `sessionID` now: none (the user's) inside the user's command on it, else `plugin`. */
export const pluginSource = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
  const mark = yield* UserCommand.Current
  return UserCommand.covers(mark, sessionID) ? undefined : ("plugin" as const)
})

/** The agent and model a command's execute selected for its session (ctx.session.switchAgent / switchModel). */
export type Selection = { agent?: Agent.ID; model?: Model.Ref }

/** The selections pending on each command extent, for that extent's own session. */
const pending = new WeakMap<UserCommand.Mark, Selection>()

const selecting = (mark: UserCommand.Mark | undefined, sessionID: SessionSchema.ID) =>
  mark !== undefined && mark.open && mark.sessionID === sessionID ? pending.get(mark) : undefined

/**
 * Runs a command's execute (`Session.command`) as its extent: a mark of its own, the user's when the server's route
 * marked the call (`userCommand`), else a plugin's or an automation's. Within it a plugin's selection of the command's
 * session's agent or model is pending (`defer`) until the extent's next prompt carries it into its admitting
 * transaction (`take`); one no prompt carried is given to `flush` when execute returns, with the rule it is admitted
 * under (`user`, or `refuse`: dropped by an archived session).
 */
export const commandExtent =
  (sessionID: SessionSchema.ID, flush: (selection: Selection, rule: Rule) => Effect.Effect<void>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const user = UserCommand.covers(yield* UserCommand.Current, sessionID)
      const mark: UserCommand.Mark = { sessionID, user, open: true }
      pending.set(mark, {})
      return yield* effect.pipe(
        Effect.provideService(UserCommand.Current, mark),
        Effect.ensuring(
          Effect.suspend(() => {
            mark.open = false
            const selection = pending.get(mark)
            pending.delete(mark)
            return selection && (selection.agent !== undefined || selection.model !== undefined)
              ? flush(selection, user ? "user" : "refuse")
              : Effect.void
          }),
        ),
      )
    })

/** Keeps a selection pending on the current command extent when it is `sessionID`'s; false: publish it now. */
export const defer = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, selection: Selection) {
  const current = selecting(yield* UserCommand.Current, sessionID)
  if (!current) return false
  Object.assign(current, selection)
  return true
})

/** The selection pending for `sessionID` (what a read of the session answers inside the extent). */
export const pendingSelection = (sessionID: SessionSchema.ID) =>
  Effect.map(UserCommand.Current, (mark) => {
    const current = selecting(mark, sessionID)
    return current && (current.agent !== undefined || current.model !== undefined) ? { ...current } : undefined
  })

/**
 * Takes the pending selection into a prompt (which publishes it in its admitting transaction). A prompt that fails
 * for a reason other than its refusal gives it back, as upstream's selection had already committed.
 */
export const carrying =
  (sessionID: SessionSchema.ID) =>
  <A, E, R>(admitting: (selection: Selection | undefined) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const mark = yield* UserCommand.Current
      const current = selecting(mark, sessionID)
      const selection =
        current && (current.agent !== undefined || current.model !== undefined) ? { ...current } : undefined
      if (mark && selection) pending.set(mark, {})
      return yield* admitting(selection).pipe(
        Effect.onError((cause) =>
          Effect.sync(() => {
            if (!mark || !selection || !mark.open) return
            const refusal = Cause.squash(cause)
            if (refusal instanceof Refused || refusal instanceof ArchivedError) return
            pending.set(mark, { ...selection, ...pending.get(mark) })
          }),
        ),
      )
    })

/** A selection's event as its admission published it. */
export type SelectionEvent =
  | Event.Payload<typeof SessionEvent.AgentSelected>
  | Event.Payload<typeof SessionEvent.ModelSelected>

/**
 * What a part of OpenCode writes in reaction to a selection (plan.ts's Plan-mode reminder). It keeps no memory of
 * having run: what it writes is a row whose ID it derives from the event, so the registrant's subscriber, hearing the
 * event after the commit, finds that row and writes nothing again (the inbox's first admission wins). A refusal rolls
 * the row back with the rest, and nothing in memory was changed to undo.
 */
export type Reaction = (event: SelectionEvent) => Effect.Effect<unknown, unknown>

type Registered = { readonly reaction: Reaction; readonly location: Location.Ref | undefined }
// The only module state the seam keeps: who listens, changed by a plugin's load and unload, never by an admission.
const reactions = new Set<Registered>()

/**
 * Registers a reaction to a command's selection, run inside the transaction that admits it, after the selection's
 * events and before the input they are admitted with: what it writes lands where it would have had the selection been
 * its own write, and a refusal rolls it back with the rest. Like a plugin's event subscriber, it hears only its own
 * location's sessions (the ambient Location at registration; none: every session). Scoped: removed with its plugin.
 */
export const onSelection = (reaction: Reaction) =>
  Effect.flatMap(Effect.serviceOption(Location.Service), (location) => {
    const entry: Registered = {
      reaction,
      location: Option.isSome(location)
        ? { directory: location.value.directory, workspaceID: location.value.workspaceID }
        : undefined,
    }
    return Effect.acquireRelease(
      Effect.sync(() => void reactions.add(entry)),
      () => Effect.sync(() => void reactions.delete(entry)),
    )
  })

const hears = (entry: Registered, location: Location.Ref) =>
  entry.location === undefined ||
  (entry.location.directory === location.directory && entry.location.workspaceID === location.workspaceID)

/**
 * Runs every reaction for the events just published, in the caller's transaction. A failure aborts it: a refusal of
 * what a reaction writes (an archived session, not the user's) is the admission's refusal.
 */
export const react = (location: Location.Ref, events: ReadonlyArray<SelectionEvent>) =>
  Effect.forEach(
    events,
    (event) =>
      Effect.forEach(
        [...reactions].filter((entry) => hears(entry, event.location ?? location)),
        (entry) => entry.reaction(event),
        { discard: true },
      ).pipe(
        Effect.catch((error) =>
          Effect.die(error instanceof ArchivedError ? new Refused(error.sessionID, "archived") : error),
        ),
        Effect.catchDefect((defect) =>
          Effect.die(defect instanceof ArchivedError ? new Refused(defect.sessionID, "archived") : defect),
        ),
      ),
    { discard: true },
  )

/**
 * The commit hook that admits a write without an input row (a command's pending selection), under `rule`: a deleted
 * session, or an archived one under `refuse`, aborts the transaction (Refused).
 */
export const guard = (input: { readonly store: Store; readonly sessionID: SessionSchema.ID; readonly rule: Rule }) =>
  Effect.gen(function* () {
    const state = yield* look(input.store, input.sessionID, input.rule === "user")
    if (state === "deleted") return yield* Effect.die(new Refused(input.sessionID, "deleted"))
    if (state === "archived" && input.rule === "refuse")
      return yield* Effect.die(new Refused(input.sessionID, "archived"))
    return state
  })

/** A source that keeps its input was refused: the session is archived. Nothing was admitted. */
export class ArchivedError extends Schema.TaggedError<ArchivedError>()("Session.ArchivedError", {
  sessionID: SessionSchema.ID,
}) {
  // What a caller that shows only a message (a command's ExecutionError) tells the user.
  override get message() {
    return `Session ${this.sessionID} is archived`
  }
}

/** The defect that aborts the admitting transaction; mapped back to a typed error by `refused`. */
export class Refused {
  readonly _tag = "SessionAdmission.Refused"
  constructor(
    readonly sessionID: SessionSchema.ID,
    readonly reason: "archived" | "deleted",
  ) {}
}

type DB = Database.Interface["db"]
type Store = Pick<SessionStore.Interface, "get">
type Wake = (sessionID: SessionSchema.ID) => Effect.Effect<void>

/**
 * What a ring decided for committed input: `live` (woken, unless the caller asked for no wake or the session is
 * stopped), `held` (in an archived session: never woken for it), `quiet` (a staged revert: not woken, as upstream),
 * `gone` (no row to ring for: its admission rolled back, a turn already took it, or the session is deleted).
 */
export type Decision = "live" | "held" | "quiet" | "gone"

/**
 * The durable mark of a held input, written in its admitting transaction: whatever later rings for that input (a
 * retried admission, the restart sweep's owed wake) finds it and rings nothing, even once the session is unarchived.
 * Only a turn the user starts takes a held input. `sweep` drops the marks of inputs no longer in an inbox.
 */
const HELD = "session.held:"

/** What the session admits now; read inside the caller's transaction. */
const look = Effect.fnUntraced(function* (store: Store, sessionID: SessionSchema.ID, user = false) {
  const session = yield* store.get(sessionID)
  if (!session) return "deleted" as const
  // The user's own input runs in an archived session as upstream's does.
  if (session.time.archived && !user) return "archived" as const
  // Upstream's rule (synthetic.ts `!(yield* get).revert`): a staged revert waits for its owner. The stop mark is the
  // `wake` function's to read (the fork's Session.stop: a notice admitted to a stopped session does not wake it).
  if (session.revert) return "quiet" as const
  return "live" as const
})

/** Whether `inputID` was admitted held (into an archived session). Reads inside the caller's transaction, if any. */
export const isHeld = Effect.fnUntraced(function* (db: DB, inputID: SessionMessage.ID) {
  const row = yield* db
    .select({ key: KVTable.key })
    .from(KVTable)
    .where(eq(KVTable.key, HELD + inputID))
    .get()
  return row !== undefined
}, Effect.orDie)

/** Holds `inputID` (written in the caller's transaction). */
const hold = (db: DB, sessionID: SessionSchema.ID, inputID: SessionMessage.ID) =>
  db
    .insert(KVTable)
    .values({ key: HELD + inputID, value: sessionID })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

/**
 * The commit hook of an admission (`Bus.PublishOptions.commit`): runs inside the InboxEnqueued transaction, after its
 * row is written, and only decides what may be written: refuses (a defect: the transaction rolls back, no row stays) or
 * marks the input held. It rings nothing: a wake is never rung for a write that may still roll back. The caller rings
 * after its admission returned, committed (`ring` with the input's ID).
 */
export const commit =
  (input: {
    readonly db: DB
    readonly store: Store
    readonly sessionID: SessionSchema.ID
    readonly inputID: SessionMessage.ID
    /** How an archived session answers (`rule(source)`). */
    readonly rule: Rule
  }) =>
  () =>
    Effect.gen(function* () {
      if ((yield* guard(input)) === "archived") yield* hold(input.db, input.sessionID, input.inputID)
    })

/** A ring was asked for inside an open transaction, whose commit it cannot see. */
export class RingInTransaction {
  readonly _tag = "SessionAdmission.RingInTransaction"
  constructor(readonly sessionID: SessionSchema.ID) {}
}

/**
 * Rings the session for input already committed, in its own write transaction, so an archive, a delete, a revert or a
 * stop commits before it (and is seen) or after the ring. Given `inputID` it re-reads the committed row first and rings
 * nothing when the row is absent (its admission rolled back, or a running turn already took it) or held; an input
 * admitted live whose session was archived before this ring is held now, so only the user's prompt takes it. The ring
 * is the last step, after `decided`. It runs only outside a transaction: the row it reads must be committed.
 */
export const ring = (input: {
  readonly db: DB
  readonly store: Store
  readonly sessionID: SessionSchema.ID
  readonly wake?: Wake
  readonly inputID?: SessionMessage.ID
  /** Told the decision, inside the ring's transaction (the restart sweep defers its wakes by it). */
  readonly decided?: (decision: Decision) => Effect.Effect<void>
  /** `user`: the user's own input, woken even in an archived session, as upstream. Default `hold`. */
  readonly rule?: Rule
}) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(input.db.$client.transactionService)))
      return yield* Effect.die(new RingInTransaction(input.sessionID))
    yield* input.db
      .transaction(
        () =>
          Effect.gen(function* () {
            const inputID = input.inputID
            if (inputID !== undefined) {
              if (yield* isHeld(input.db, inputID)) return yield* tell("held")
              if ((yield* SessionInbox.find(input.db, inputID)) === undefined) return yield* tell("gone")
            }
            const state = yield* look(input.store, input.sessionID, input.rule === "user")
            if (state === "deleted") return yield* tell("gone")
            if (state === "archived") {
              if (inputID !== undefined) yield* hold(input.db, input.sessionID, inputID)
              return yield* tell("held")
            }
            yield* tell(state)
            if (state === "live" && input.wake) yield* input.wake(input.sessionID)
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
    function tell(decision: Decision) {
      return input.decided ? input.decided(decision) : Effect.void
    }
  })

/** Drops the held marks of inputs no longer in any inbox (a user's turn took them, or the session is gone). */
export const sweep = (db: DB) =>
  db
    .delete(KVTable)
    .where(
      and(
        like(KVTable.key, `${HELD}%`),
        notExists(
          db
            .select({ id: SessionInboxTable.id })
            .from(SessionInboxTable)
            .where(eq(sql`${HELD} || ${SessionInboxTable.id}`, KVTable.key)),
        ),
      ),
    )
    .run()
    .pipe(Effect.orDie, Effect.asVoid)

/**
 * Maps a delete that refused an admission (the refusal, or the foreign-key defect of a delete racing it) to the
 * session's typed NotFoundError. An archive's refusal stays the `Refused` defect, so the error types of the session's
 * operations stay upstream's: only a source that keeps its input can meet it, and its caller maps it (`typed`).
 */
export const refused = <A, E, R>(store: Store, sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchDefect((defect): Effect.Effect<never, NotFoundError> => {
      if (defect instanceof Refused)
        return defect.reason === "deleted" ? Effect.fail(new NotFoundError({ sessionID })) : Effect.die(defect)
      return store
        .get(sessionID)
        .pipe(
          Effect.flatMap((session) =>
            session === undefined ? Effect.fail(new NotFoundError({ sessionID })) : Effect.die(defect),
          ),
        )
    }),
  )

/** The archive refusal, made a typed error for a caller that keeps its input (the plugin host, the HTTP route). */
export const typed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchDefect((defect) =>
      defect instanceof Refused && defect.reason === "archived"
        ? Effect.fail(new ArchivedError({ sessionID: defect.sessionID }))
        : Effect.die(defect),
    ),
  )
