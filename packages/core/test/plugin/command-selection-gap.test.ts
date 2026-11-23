// Fork feature (synthetic-archived): the gap between a command's selection and the prompt it is admitted with. The
// selection is pending until the prompt's admitting transaction writes it, its reactions (plan.ts's reminder) and the
// prompt together, under the session's publish lock; an archive landing anywhere before that transaction refuses the
// prompt and leaves the session's rows byte-identical, and one attempted inside it waits for its commit. On the real
// location, config command plugin, plan plugin, a local Promise plugin and runner (command-selection-order.test.ts).
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Session } from "@opencode/core/session"
import { SessionAdmission } from "@opencode/core/session/admission"
import { SessionStore } from "@opencode/core/session/store"
import { dump } from "../fixture/admission-model"
import { commandLayer, project, sequence } from "../fixture/command-selection"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

/** Runs once, at the first read of the session made while a selection is pending on it. */
const armed: { action?: Effect.Effect<void> } = {}

const store = SessionStore.node.replace(
  SessionStore.node.mapLayer((layer) =>
    Layer.effect(
      SessionStore.Service,
      Effect.gen(function* () {
        const inner: SessionStore.Interface = yield* SessionStore.Service
        return SessionStore.Service.of({
          ...inner,
          get: (sessionID) =>
            inner.get(sessionID).pipe(
              Effect.tap(() =>
                SessionAdmission.pendingSelection(sessionID).pipe(
                  Effect.flatMap((selection) => {
                    const action = armed.action
                    if (!selection || !action) return Effect.void
                    armed.action = undefined
                    return action
                  }),
                ),
              ),
            ),
        })
      }).pipe(Effect.provide(layer)),
    ),
  ),
)

const it = testEffect(commandLayer([store]))

const plan = Agent.ID.make("plan")
const build = Agent.ID.make("build")
/** The owner's archive as an effect that also answers the session's rows right after it. */
const archiving = (
  sessions: Session.Interface,
  db: Database.Interface["db"],
  sessionID: Session.ID,
  rows: Deferred.Deferred<string>,
) =>
  Effect.gen(function* () {
    yield* sessions.archive(sessionID).pipe(Effect.orDie)
    yield* Deferred.succeed(rows, yield* dump(db, sessionID))
  })

describe("the gap between a command's selection and its prompt", () => {
  it.live("archived after the selection, before its prompt: refused, rows byte-identical, nothing selected", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const rows = yield* Deferred.make<string>()
      armed.action = archiving(sessions, db, session.id, rows)
      // No user mark: a plugin's or an automation's command.
      const exit = yield* sessions.command({ sessionID: session.id, command: "pick", text: "x" }).pipe(Effect.exit)
      armed.action = undefined
      expect(Exit.isFailure(exit)).toBe(true)
      yield* sessions.wait(session.id)
      expect(yield* dump(db, session.id)).toBe(yield* Deferred.await(rows))
      const info = yield* sessions.get(session.id)
      expect([info.agent, info.model?.id]).toEqual([build, Model.ID.make("m")])
      expect(yield* sessions.inbox(session.id)).toEqual([])
    }),
  )

  // /pick's reminder (a plugin's synthetic) is itself refused inside the transaction; /m2 selects a model only, so
  // the admission's own check inside the transaction is all that refuses it.
  for (const name of ["pick", "m2"])
    it.live(
      `/${name}: archived while the prompt is prepared (its hook): refused, rows byte-identical, nothing selected`,
      () =>
        Effect.gen(function* () {
          const session = yield* project()
          const sessions = yield* Session.Service
          const { db } = yield* Database.Service
          const rows = yield* Deferred.make<string>()
          // The local plugin's prompt hook runs the archive (fixture: globalThis.__onPrompt).
          ;(globalThis as { __onPrompt?: () => Promise<void> }).__onPrompt = () =>
            Effect.runPromise(archiving(sessions, db, session.id, rows))
          const exit = yield* sessions.command({ sessionID: session.id, command: name, text: "x" }).pipe(Effect.exit)
          ;(globalThis as { __onPrompt?: unknown }).__onPrompt = undefined
          expect(Exit.isFailure(exit)).toBe(true)
          yield* sessions.wait(session.id)
          expect(yield* dump(db, session.id)).toBe(yield* Deferred.await(rows))
          const info = yield* sessions.get(session.id)
          expect([info.agent, info.model?.id]).toEqual([build, Model.ID.make("m")])
        }),
    )

  it.live("archive attempted inside the admitting transaction waits for its commit; the prompt is admitted", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const go = yield* Deferred.make<void>()
      const waited = yield* Deferred.make<boolean>()
      // The owner's archive, as another request would run it: a fiber of its own, not one of the transaction's.
      const archive = yield* Deferred.await(go).pipe(Effect.andThen(sessions.archive(session.id)), Effect.forkChild)
      // A reaction (the seam plan.ts uses) lets the archive start from inside the transaction.
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* SessionAdmission.onSelection(() =>
            Effect.gen(function* () {
              if (yield* Deferred.isDone(go)) return false
              yield* Deferred.succeed(go, undefined)
              yield* Effect.sleep(50)
              // Still waiting: the transaction holds the session.
              yield* Deferred.succeed(waited, archive.pollUnsafe() === undefined)
              return false
            }),
          )
          const types = yield* sequence(session.id, "pick", SessionAdmission.userCommand(session.id))
          expect(types.slice(0, 4)).toEqual(["agent-switched", "model-switched", "synthetic", "user"])
        }),
      )
      expect(yield* Deferred.await(waited)).toBe(true)
      yield* Fiber.join(archive)
      expect((yield* sessions.get(session.id)).time.archived).toBeDefined()
    }),
  )

  it.live(
    "a reaction that fails, or is refused, refuses the admission: nothing written; the session is free after",
    () =>
      Effect.gen(function* () {
        const session = yield* project()
        const sessions = yield* Session.Service
        const { db } = yield* Database.Service
        for (const failure of [
          Effect.die("a reaction's defect"),
          Effect.fail(new SessionAdmission.ArchivedError({ sessionID: session.id })),
        ]) {
          const before = yield* dump(db, session.id)
          const exit = yield* Effect.scoped(
            SessionAdmission.onSelection(() => failure.pipe(Effect.as(false))).pipe(
              Effect.andThen(sessions.command({ sessionID: session.id, command: "pick", text: "x" })),
              Effect.exit,
            ),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          expect(yield* dump(db, session.id)).toBe(before)
        }
        // Released on every exit: the next prompt and an archive go through at once.
        yield* sessions.prompt({ sessionID: session.id, text: "next", resume: false }).pipe(Effect.timeout("5 seconds"))
        yield* sessions.archive(session.id).pipe(Effect.timeout("5 seconds"))
      }),
  )

  it.live(
    "refused after plan's reminder ran: nothing kept, rows or memory; the same selection later writes it once",
    () =>
      Effect.gen(function* () {
        const session = yield* project()
        const sessions = yield* Session.Service
        const { db } = yield* Database.Service
        const rows = yield* dump(db, session.id)
        // plan.ts's reaction (registered first, at the plugin's load) writes its reminder for the agent's event; this
        // one then refuses the model's, after it: the whole admission rolls back.
        const exit = yield* Effect.scoped(
          SessionAdmission.onSelection((event) =>
            event.type === "session.model.selected"
              ? Effect.fail(new SessionAdmission.ArchivedError({ sessionID: session.id }))
              : Effect.void,
          ).pipe(Effect.andThen(sessions.command({ sessionID: session.id, command: "pick", text: "x" })), Effect.exit),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* dump(db, session.id)).toBe(rows)
        // Admitted later in the same process: the reminder is written once, in upstream's place.
        expect(yield* sequence(session.id, "pick")).toEqual([
          "agent-switched",
          "model-switched",
          "synthetic",
          "user",
          "assistant",
          "idle",
        ])
      }),
  )

  it.live(
    "the reminder is a row named by its event: admitting it again (the subscriber, a restart) writes nothing",
    () =>
      Effect.gen(function* () {
        const session = yield* project()
        const sessions = yield* Session.Service
        const { db } = yield* Database.Service
        yield* sequence(session.id, "pick")
        const messages = yield* sessions.messages({ sessionID: session.id, order: "asc" })
        const selected = messages.find((message) => message.type === "agent-switched")
        const reminder = messages.find((message) => message.type === "synthetic")
        expect(selected && reminder).toBeTruthy()
        // The reminder's ID is the selection event's, suffixed (plan.ts `reminderID`): a process that lost its memory after the
        // commit derives it again from the row's event and finds the row.
        expect(String(reminder!.id)).toBe(`${String(selected!.id)}_plan`)
        const rows = yield* dump(db, session.id)
        yield* sessions.synthetic({
          sessionID: session.id,
          id: reminder!.id,
          text: (reminder as { text: string }).text,
          resume: false,
        })
        expect(yield* dump(db, session.id)).toBe(rows)
      }),
  )

  it.live("two commands selecting at once in one session: the transaction decides, one switch and one reminder", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      yield* Effect.all(
        [
          sessions.command({ sessionID: session.id, command: "pick", text: "one" }),
          sessions.command({ sessionID: session.id, command: "pick", text: "two" }),
        ],
        { concurrency: "unbounded" },
      )
      yield* sessions.wait(session.id)
      yield* Effect.sleep(50)
      const types = (yield* sessions.messages({ sessionID: session.id, order: "asc" })).map((message) => message.type)
      const inbox = (yield* sessions.inbox(session.id)).map((item) => item.type)
      const all = [...types, ...inbox]
      expect(all.filter((type) => type === "agent-switched")).toHaveLength(1)
      expect(all.filter((type) => type === "model-switched")).toHaveLength(1)
      expect(all.filter((type) => type === "synthetic")).toHaveLength(1)
      expect(all.filter((type) => type === "user")).toHaveLength(2)
    }),
  )

  it.live("two locations loaded: only the selection's own location reacts and writes a Plan reminder", () =>
    Effect.gen(function* () {
      const one = yield* project()
      const two = yield* project()
      yield* sequence(two.id, "m2")
      yield* sequence(one.id, "m2")
      // The reminder's idempotency could otherwise conceal a second location reacting.
      const foreign: string[] = []
      yield* SessionAdmission.onSelection((event) => Effect.sync(() => void foreign.push(event.type))).pipe(
        Effect.provideService(Location.Service, Location.Service.of(location(two.location))),
      )
      expect(yield* sequence(one.id, "pick")).toEqual(["agent-switched", "synthetic", "user", "assistant", "idle"])
      expect(foreign).toEqual([])
    }),
  )

  it.live("read back inside the command, the pending selection answers before anything is written", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const stored = yield* Deferred.make<Agent.ID | undefined>()
      armed.action = sessions.get(session.id).pipe(
        Effect.flatMap((info) => Deferred.succeed(stored, info.agent)),
        Effect.asVoid,
        Effect.orDie,
      )
      // Nested inside the armed read: disarm so its own read does not recurse.
      yield* sequence(session.id, "read")
      armed.action = undefined
      const read = (globalThis as { __selectionRead?: Record<string, string> }).__selectionRead?.[session.id]
      expect(read).toContain('"plan"')
      expect(yield* Deferred.await(stored)).toBe(build)
      expect((yield* sessions.get(session.id)).agent).toBe(plan)
    }),
  )

  it.live("two commands at once in two sessions: each selection lands on its own session", () =>
    Effect.gen(function* () {
      const one = yield* project()
      const two = yield* project()
      const sessions = yield* Session.Service
      yield* Effect.all([sequence(one.id, "select"), sequence(two.id, "m2")], { concurrency: "unbounded" })
      const [a, b] = [yield* sessions.get(one.id), yield* sessions.get(two.id)]
      expect([a.agent, a.model?.id]).toEqual([plan, Model.ID.make("m2")])
      expect([b.agent, b.model?.id]).toEqual([build, Model.ID.make("m2")])
    }),
  )

  it.live(
    "no deadlock: archive, two commands, the user's prompt and a notice on one session, in 24 of the 120 start orders",
    () =>
      Effect.gen(function* () {
        const actors = ["archive", "pick", "pick2", "prompt", "notice"] as const
        const orders = permutations([...actors]).filter((_, index) => index % 5 === 0)
        for (const order of orders) {
          const session = yield* project()
          const sessions = yield* Session.Service
          const act = (actor: (typeof actors)[number]): Effect.Effect<unknown, unknown> => {
            if (actor === "archive") return sessions.archive(session.id)
            if (actor === "pick" || actor === "pick2")
              return sessions.command({ sessionID: session.id, command: "pick", text: actor })
            if (actor === "prompt") return sessions.prompt({ sessionID: session.id, text: "the user's", resume: false })
            return sessions.synthetic({ sessionID: session.id, text: "a notice", source: "shell", resume: false })
          }
          const exits = yield* Effect.all(
            order.map((actor, index) => Effect.sleep(index).pipe(Effect.andThen(act(actor)), Effect.exit)),
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("20 seconds"))
          expect(exits).toHaveLength(actors.length)
          yield* sessions.wait(session.id).pipe(Effect.timeout("20 seconds"))
        }
      }),
    120_000,
  )
})

function permutations<A>(items: A[]): A[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  )
}
