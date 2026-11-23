// Fork feature (synthetic-archived): the drizzle session's after-commit and rollback work. Work registered with
// `afterCommit` runs once the outermost transaction commits and never after a rollback; `onRollback` work (the undo of
// an in-memory effect made inside) runs when its transaction or savepoint rolls back, last first, and never on commit.
import { describe, expect } from "bun:test"
import { Data, Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { afterCommit, onRollback } from "@opencode/core/database/drizzle/effect-sqlite/session"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))

class Abort extends Data.TaggedError("Abort")<{}> {}

const recorder = () => {
  const log: string[] = []
  const note = (entry: string) => Effect.sync(() => void log.push(entry))
  return { log, note }
}

describe("a transaction's after-commit and rollback work", () => {
  it.effect("committed: the commit work runs after it, the undo work never", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { log, note } = recorder()
      yield* db.transaction(
        () =>
          Effect.gen(function* () {
            yield* afterCommit(db.$client, note("committed"))
            yield* onRollback(db.$client, note("undone"))
            yield* note("inside")
          }),
        { behavior: "immediate" },
      )
      expect(log).toEqual(["inside", "committed"])
    }),
  )

  it.effect("rolled back: the undo work runs, last first; the commit work never", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { log, note } = recorder()
      yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              yield* afterCommit(db.$client, note("committed"))
              yield* onRollback(db.$client, note("undo first"))
              yield* onRollback(db.$client, note("undo second"))
              return yield* new Abort()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.ignore)
      expect(log).toEqual(["undo second", "undo first"])
    }),
  )

  it.effect("a savepoint rolled back inside a committed transaction: its undo runs, the outer commit work runs", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { log, note } = recorder()
      yield* db.transaction(
        () =>
          Effect.gen(function* () {
            yield* afterCommit(db.$client, note("outer committed"))
            yield* db
              .transaction(() =>
                Effect.gen(function* () {
                  yield* afterCommit(db.$client, note("inner committed"))
                  yield* onRollback(db.$client, note("inner undone"))
                  return yield* new Abort()
                }),
              )
              .pipe(Effect.ignore)
          }),
        { behavior: "immediate" },
      )
      expect(log).toEqual(["inner undone", "outer committed"])
    }),
  )

  it.effect("a released savepoint inside a rolled-back transaction: its undo runs with the outer one's", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { log, note } = recorder()
      yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              yield* onRollback(db.$client, note("outer undone"))
              yield* db.transaction(() => onRollback(db.$client, note("inner undone")))
              return yield* new Abort()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.ignore)
      expect(log).toEqual(["inner undone", "outer undone"])
    }),
  )

  it.effect("outside a transaction: after-commit work runs at once, undo work never", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { log, note } = recorder()
      yield* afterCommit(db.$client, note("now"))
      yield* onRollback(db.$client, note("undone"))
      expect(log).toEqual(["now"])
    }),
  )
})
