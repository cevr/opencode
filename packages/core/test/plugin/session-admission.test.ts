// Fork feature (synthetic-archived): a plugin's input to an archived session is refused and the plugin is told, except
// inside the user's own slash command on that session (the server's `session.command` route runs it in
// SessionAdmission.userCommand). The mark is the host's, never an argument: it closes when the command's execute
// returns, a command a plugin runs does not inherit it, and it covers only the commanded session.
import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit } from "effect"
import { Command } from "@opencode/core/command"
import { Database } from "@opencode/core/database/database"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Session } from "@opencode/core/session"
import { SessionAdmission } from "@opencode/core/session/admission"
import { SessionInbox } from "@opencode/core/session/inbox"
import { define } from "@opencode/plugin/effect/plugin"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

/** What the plugin's command saw: the result of each admission it tried, by name. */
type Seen = Map<string, "admitted" | string>

// A command's failure arrives wrapped (Command.ExecutionError), its message the inner error's.
const tag = (cause: unknown) => {
  const error = cause as { _tag?: string; message?: string } | undefined
  if (error?._tag === "Command.ExecutionError") return `${error._tag}: ${error.message}`
  return error?._tag ?? String(cause)
}

/** Commands and plugins are registered per test: the layer, and so its command registry, is shared. */
let count = 0

const setup = Effect.gen(function* () {
  const n = ++count
  const plugins = yield* Plugin.Service
  const sessions = yield* Session.Service
  const commands = yield* Command.Service
  const database = yield* Database.Service
  const host = yield* PluginHost.make(plugins, "test")
  const seen: Seen = new Map()
  const later = yield* Deferred.make<void>()
  const note = (name: string, effect: Effect.Effect<unknown, unknown>) =>
    effect.pipe(
      Effect.exit,
      Effect.map((exit) => seen.set(name, Exit.isSuccess(exit) ? "admitted" : tag(Cause.squash(exit.cause)))),
    )
  const letter = (sessionID: string, text: string) => ({ sessionID: Session.ID.make(sessionID), text, resume: false })

  // An Effect plugin: `probe` admits to its session, `cross` to another (`text` names it), `nested` runs `probe` as a
  // plugin's command, `later` admits after its execute returned.
  yield* define({
    id: `test.admission-effect-${n}`,
    effect: (ctx) =>
      ctx.command
        .transform((editor) => {
          editor.add({
            name: `probe-${n}`,
            execute: (input) =>
              note(`probe:${input.prompt.text}`, ctx.session.synthetic(letter(input.sessionID, "probe"))).pipe(
                Effect.asVoid,
              ),
          })
          editor.add({
            name: `cross-${n}`,
            execute: (input) =>
              note("cross", ctx.session.synthetic(letter(input.prompt.text, "cross"))).pipe(Effect.asVoid),
          })
          editor.add({
            name: `nested-${n}`,
            execute: (input) =>
              note("nested", ctx.session.command({ sessionID: input.sessionID, name: "init", text: "nested" })).pipe(
                Effect.asVoid,
              ),
          })
          editor.add({
            name: `later-${n}`,
            execute: (input) =>
              Deferred.await(later).pipe(
                Effect.andThen(note("later", ctx.session.synthetic(letter(input.sessionID, "later")))),
                Effect.forkDetach,
                Effect.asVoid,
              ),
          })
        })
        .pipe(Effect.asVoid),
  }).effect(host)

  // A Promise plugin: its awaits cross the host's Effect runtime, so the mark rides AsyncLocalStorage.
  const promised: { later?: Promise<unknown>; result?: string } = {}
  yield* PluginPromise.fromPromise({
    id: `test.admission-promise-${n}`,
    async setup(ctx) {
      await ctx.command.transform((editor) => {
        editor.add({
          name: `promise-probe-${n}`,
          execute: async (input) => {
            await new Promise((resolve) => setTimeout(resolve, 1))
            await ctx.session.synthetic(letter(input.sessionID, "promise-probe"))
            promised.result = "admitted"
          },
        })
        editor.add({
          name: `promise-later-${n}`,
          execute: async (input) => {
            promised.later = new Promise((resolve) => setTimeout(resolve, 5)).then(() =>
              ctx.session.synthetic(letter(input.sessionID, "promise-later")),
            )
          },
        })
      })
    },
  }).effect(host)

  const session = yield* host.session.create({ title: "archived" })
  const other = yield* host.session.create({ title: "other" })
  yield* sessions.archive(session.id)
  const run = (name: string, sessionID: string, text = "") =>
    commands
      .execute({
        name: `${name}-${n}`,
        invocation: { sessionID: sessionID as never, prompt: { text }, delivery: "steer" },
      })
      .pipe(Effect.exit)
  const rows = Effect.map(SessionInbox.list(database.db, session.id), (items) => items.length)
  return { sessions, session, other, seen, later, promised, run, rows }
})

describe("a plugin's input and the user's own command", () => {
  it.live("the user's command admits to its archived session; the same command run by a plugin is refused", () =>
    Effect.gen(function* () {
      const t = yield* setup
      // The server's route: the user typed /probe in the archived session.
      yield* SessionAdmission.userCommand(t.session.id)(t.run("probe", t.session.id, "user"))
      expect(t.seen.get("probe:user")).toBe("admitted")
      expect(yield* t.rows).toBe(1)

      // A non-user caller (an automation, a plugin calling Session.command): not the user's, refused and told.
      yield* t.run("probe", t.session.id, "plain")
      expect(t.seen.get("probe:plain")).toBe("Session.ArchivedError")

      // A command a plugin runs (ctx.session.command: the built-in /init, which prompts its session) from inside the
      // user's own command does not inherit the mark: its prompt is refused, and the plugin is told.
      yield* SessionAdmission.userCommand(t.session.id)(t.run("nested", t.session.id))
      expect(t.seen.get("nested")).toStartWith("Command.ExecutionError")
      expect(yield* t.rows).toBe(1)
      // The same /init, typed by the user, is admitted.
      const typed = yield* SessionAdmission.userCommand(t.session.id)(
        t.sessions.command({ sessionID: t.session.id, command: "init", text: "" }),
      ).pipe(Effect.exit)
      expect(Exit.isSuccess(typed)).toBe(true)
    }),
  )

  it.live("the mark covers only the commanded session, also with two commands at once", () =>
    Effect.gen(function* () {
      const t = yield* setup
      // The user's command on the live session admits to the archived one: a plugin's input there, refused.
      yield* Effect.all(
        [
          SessionAdmission.userCommand(t.other.id)(t.run("cross", t.other.id, t.session.id)),
          SessionAdmission.userCommand(t.session.id)(t.run("probe", t.session.id, "concurrent")),
        ],
        { concurrency: "unbounded" },
      )
      expect(t.seen.get("cross")).toBe("Session.ArchivedError")
      expect(t.seen.get("probe:concurrent")).toBe("admitted")
      expect(yield* t.rows).toBe(1)
    }),
  )

  it.live("work a command leaves running after its execute returned is a plugin's: refused", () =>
    Effect.gen(function* () {
      const t = yield* setup
      yield* SessionAdmission.userCommand(t.session.id)(t.run("later", t.session.id))
      yield* Deferred.succeed(t.later, undefined)
      yield* Effect.sleep(20)
      expect(t.seen.get("later")).toBe("Session.ArchivedError")
      expect(yield* t.rows).toBe(0)
    }),
  )

  it.live("a Promise plugin's command keeps the mark across its awaits, and loses it after it returned", () =>
    Effect.gen(function* () {
      const t = yield* setup
      expect(
        Exit.isSuccess(yield* SessionAdmission.userCommand(t.session.id)(t.run("promise-probe", t.session.id))),
      ).toBe(true)
      expect(t.promised.result).toBe("admitted")
      expect(yield* t.rows).toBe(1)

      yield* SessionAdmission.userCommand(t.session.id)(t.run("promise-later", t.session.id))
      // The plugin is told: its promise rejects.
      const later = yield* Effect.promise(() =>
        t.promised.later!.then(
          () => "admitted",
          (error: unknown) => error,
        ),
      )
      expect(later).not.toBe("admitted")
      expect(JSON.stringify(later) + String(later)).toContain("Session.ArchivedError")
      expect(yield* t.rows).toBe(1)
    }),
  )
})
