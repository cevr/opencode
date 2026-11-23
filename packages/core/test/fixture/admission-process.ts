// Fork feature (synthetic-archived): one OpenCode process of session-admission-processes.test.ts, over the database
// file the other process also opens (as the CLI's standalone server and the service do). It runs one actor and can
// stop at one named step until the test lets it go:
//   bun admission-process.ts <db file> <control dir> <sessionID> command <step|none> [pick|m2]
//     a plugin's /pick (not the user's; /m2 selects a model only, so no Plan reminder is written): steps `selected` (its selection pending, before its prompt), `prepare` (inside
//     the prompt's hook), `inside` (inside the admitting transaction, holding SQLite's write lock)
//   bun admission-process.ts <db file> <control dir> <sessionID> archive <step|none>
//     the owner's archive: step `inside` (inside the archive's transaction, holding the write lock)
// At a step it writes `<control>/<step>` and waits for `<control>/go-<step>`. Its last stdout line is its outcome.
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { Database } from "@opencode/core/database/database"
import { Session } from "@opencode/core/session"
import { SessionAdmission } from "@opencode/core/session/admission"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionStore } from "@opencode/core/session/store"
import { commandLayer } from "./command-selection"

const [file = "", control = "", id = "", actor = "", step = "none", commandName = "pick"] = process.argv.slice(2)
const sessionID = Session.ID.make(id)

/** Stops here when `name` is this process's step: tells the test, waits for its go. Once. */
let stopped = false
const at = (name: string) =>
  Effect.promise(async () => {
    if (name !== step || stopped) return
    stopped = true
    writeFileSync(path.join(control, name), String(process.pid))
    const go = path.join(control, `go-${name}`)
    for (let waited = 0; !existsSync(go); waited += 10) {
      if (waited > 60_000) throw new Error(`no go for ${name}`)
      await Bun.sleep(10)
    }
  })

// `selected`: the first read of the session made while a selection is pending on it.
const store = SessionStore.node.replace(
  SessionStore.node.mapLayer((layer) =>
    Layer.effect(
      SessionStore.Service,
      Effect.gen(function* () {
        const inner: SessionStore.Interface = yield* SessionStore.Service
        return SessionStore.Service.of({
          ...inner,
          get: (sessionID) =>
            inner
              .get(sessionID)
              .pipe(
                Effect.tap(() =>
                  SessionAdmission.pendingSelection(sessionID).pipe(
                    Effect.flatMap((selection) => (selection ? at("selected") : Effect.void)),
                  ),
                ),
              ),
        })
      }).pipe(Effect.provide(layer)),
    ),
  ),
)

/** A plugin's command whose prompt was refused: the command plugin reports it as its execution's failure. */
const refusedCommand = (error: unknown) => error instanceof Command.ExecutionError && /archived/i.test(error.message)

const runtime = ManagedRuntime.make(commandLayer([store, Database.node.replace(Database.configured({ path: file }))]))

const command = Effect.gen(function* () {
  const sessions = yield* Session.Service
  // `prepare`: the local plugin's prompt hook (fixture/command-selection.ts) awaits this.
  ;(globalThis as { __onPrompt?: () => Promise<void> }).__onPrompt = () => runtime.runPromise(at("prepare"))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      // `inside`: a reaction runs inside the admitting transaction, after its first write.
      yield* SessionAdmission.onSelection(() => at("inside").pipe(Effect.as(false)))
      writeFileSync(path.join(control, "command-started"), "")
      return yield* sessions.command({ sessionID, command: commandName, text: "from process B" }).pipe(Effect.exit)
    }),
  ).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit)
        ? sessions.wait(sessionID).pipe(Effect.as("admitted"))
        : Effect.succeed(
            Cause.squash(exit.cause) instanceof SessionAdmission.Refused ||
              Cause.squash(exit.cause) instanceof SessionAdmission.ArchivedError
              ? "refused"
              : refusedCommand(Cause.squash(exit.cause))
                ? "refused"
                : `failed: ${String(Cause.squash(exit.cause))} ${JSON.stringify(Cause.squash(exit.cause))}`,
          ),
    ),
  )
})

const archive = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const bus = yield* Bus.Service
  // `inside`: a projector of the archive's event runs inside its transaction.
  yield* bus.project(SessionEvent.Archived, () => at("inside"))
  writeFileSync(path.join(control, "archive-started"), "")
  yield* sessions.archive(sessionID)
  return "archived"
})

const outcome = await runtime
  .runPromise(
    (actor === "archive" ? archive : command).pipe(
      Effect.catchCause((cause) => Effect.succeed(`failed: ${Cause.pretty(cause)}`)),
    ),
  )
  .catch((error) => `failed: ${String(error)}`)
await runtime.dispose()
console.log(JSON.stringify({ actor, step, outcome }))
