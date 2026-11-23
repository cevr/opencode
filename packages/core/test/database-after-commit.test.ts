// Fork feature (synthetic-archived): the drizzle session's after-commit work. Work registered with `afterCommit` runs
// once the outermost transaction commits, in order, and never after a rollback: a savepoint that rolls back drops its
// own, one released hands it to its parent. It is the only in-memory effect path inside a transaction: nothing is done
// in memory there that a rollback would have to undo, so no driver needs a rollback callback.
import { describe, expect } from "bun:test"
import { Data, Effect, Exit } from "effect"
import { Database } from "@opencode/core/database/database"
import { afterCommit, managesTransactionsNatively } from "@opencode/core/database/drizzle/effect-sqlite/session"
import { testEffect } from "./lib/effect"
import { databaseLayer, driver } from "./fixture/test-database"

const it = testEffect(databaseLayer())

class Abort extends Data.TaggedError("Abort")<{}> {}

const recorder = () => {
  const log: string[] = []
  const note = (entry: string) => Effect.sync(() => void log.push(entry))
  return { log, note }
}

describe("a transaction's after-commit work", () => {
  it.effect(`runs on the driver OPENCODE_TEST_SQLITE names (${driver})`, () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // Durable Object SQLite manages its transactions itself and has no rollback callback.
      expect(managesTransactionsNatively(db.$client)).toBe(driver === "durable-object")
    }),
  )

  it.effect("committed: runs after it, in order", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { log, note } = recorder()
      yield* db.transaction(
        () =>
          Effect.gen(function* () {
            yield* afterCommit(db.$client, note("first"))
            yield* afterCommit(db.$client, note("second"))
            yield* note("inside")
          }),
        { behavior: "immediate" },
      )
      expect(log).toEqual(["inside", "first", "second"])
    }),
  )

  it.effect("rolled back: never runs", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { log, note } = recorder()
      yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              yield* afterCommit(db.$client, note("committed"))
              return yield* new Abort()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.ignore)
      expect(log).toEqual([])
    }),
  )

  // Durable Object SQLite has no savepoints: the nested failure dooms the outer transaction (database-drivers.test.ts).
  it.effect("a savepoint rolled back inside a committed transaction: its work dropped, the outer's runs", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { log, note } = recorder()
      const exit = yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              yield* afterCommit(db.$client, note("outer"))
              yield* db
                .transaction(() =>
                  Effect.gen(function* () {
                    yield* afterCommit(db.$client, note("inner"))
                    return yield* new Abort()
                  }),
                )
                .pipe(Effect.ignore)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(driver === "bun:sqlite")
      expect(log).toEqual(driver === "bun:sqlite" ? ["outer"] : [])
    }),
  )

  it.effect("a released savepoint inside a rolled-back transaction: nothing runs", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { log, note } = recorder()
      yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              yield* db.transaction(() => afterCommit(db.$client, note("inner")))
              return yield* new Abort()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.ignore)
      expect(log).toEqual([])
    }),
  )

  it.effect("outside a transaction: runs at once", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const { log, note } = recorder()
      yield* afterCommit(db.$client, note("now"))
      expect(log).toEqual(["now"])
    }),
  )
})
