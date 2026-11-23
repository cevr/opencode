import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { SqlError } from "effect/sql/SqlError"
import { sqliteLayer } from "@opencode/core/database/sqlite.workerd"
import type { DurableObjectStorage } from "@opencode/core/database/sqlite.workerd"
import { makeDurableObjectStorage } from "./fixture/durable-object-storage"
import { tempGlobalLayer } from "./fixture/global"

const run = <A, E>(storage: DurableObjectStorage, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(sqliteLayer({ storage })), Effect.scoped))

describe("sqlite.workerd", () => {
  test("executes statements with bindings and maps rows to records", async () => {
    const rows = await run(
      makeDurableObjectStorage(),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`
        yield* sql`INSERT INTO item (id, name) VALUES (${1}, ${"one"}), (${2}, ${"two"})`
        return yield* sql<{ id: number; name: string }>`SELECT id, name FROM item ORDER BY id`
      }),
    )
    expect(rows).toEqual([
      { id: 1, name: "one" },
      { id: 2, name: "two" },
    ])
  })

  test("normalizes ArrayBuffer blob values to Uint8Array", async () => {
    const rows = await run(
      makeDurableObjectStorage(),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE blob (data BLOB NOT NULL)`
        yield* sql`INSERT INTO blob (data) VALUES (${new Uint8Array([1, 2, 3])})`
        return yield* sql<{ data: Uint8Array }>`SELECT data FROM blob`
      }),
    )
    expect(rows[0].data).toBeInstanceOf(Uint8Array)
    expect(Array.from(rows[0].data)).toEqual([1, 2, 3])
  })

  test("withTransaction commits on success and rolls back on failure", async () => {
    const storage = makeDurableObjectStorage()
    const count = await run(
      storage,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE t (value TEXT NOT NULL)`
        yield* sql.withTransaction(sql`INSERT INTO t (value) VALUES (${"kept"})`)
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO t (value) VALUES (${"discarded"})`
              return yield* Effect.fail("rollback")
            }),
          )
          .pipe(Effect.ignore)
        return yield* sql<{ count: number }>`SELECT count(*) AS count FROM t`
      }),
    )
    expect(count[0].count).toBe(1)
  })

  test("a nested transaction joins its outer, but a caught inner failure still rolls back both", async () => {
    const rows = await run(
      makeDurableObjectStorage(),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE t (value TEXT NOT NULL)`
        yield* sql.withTransaction(sql.withTransaction(sql`INSERT INTO t (value) VALUES (${"kept"})`))
        const failure = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO t (value) VALUES (${"outer"})`
              yield* sql
                .withTransaction(
                  sql`INSERT INTO t (value) VALUES (${"inner"})`.pipe(Effect.andThen(Effect.fail("abort inner"))),
                )
                .pipe(Effect.ignore)
              const later = yield* sql`INSERT INTO t (value) VALUES (${"later"})`.pipe(Effect.flip)
              expect(later.message).toContain("abort inner")
              const nested = yield* sql.withTransaction(Effect.void).pipe(Effect.flip)
              expect(nested).toBe(later)
            }),
          )
          .pipe(Effect.flip)
        expect(failure).toBeInstanceOf(SqlError)
        expect(failure instanceof SqlError && failure.message).toStartWith("NestedTransactionFailed:")
        expect(failure instanceof SqlError && failure.message).toContain("abort inner")
        return yield* sql`SELECT value FROM t`
      }),
    )
    expect(rows).toEqual([{ value: "kept" }])
  })

  test("interrupting a running transaction rolls it back before releasing the connection", async () => {
    await run(
      makeDurableObjectStorage(),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const written = yield* Deferred.make<void>()
        const committed: string[] = []
        yield* sql`CREATE TABLE t (value TEXT NOT NULL)`
        const fiber = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO t VALUES ('discarded')`
              yield* sql.afterCommit(Effect.sync(() => void committed.push("interrupted")))
              yield* Deferred.succeed(written, undefined)
              return yield* Effect.never
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(written)
        yield* Fiber.interrupt(fiber)
        yield* sql.withTransaction(sql`INSERT INTO t VALUES ('kept')`)
        expect(committed).toEqual([])
        expect(yield* sql`SELECT value FROM t`).toEqual([{ value: "kept" }])
      }),
    )
  })

  test("native afterCommit waits for storage, does not run on failed COMMIT, and can query after release", async () => {
    const ran: string[] = []
    await run(
      makeDurableObjectStorage(),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
        yield* sql`CREATE TABLE child (parent INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
        const note = (entry: string) => sql.afterCommit(Effect.sync(() => void ran.push(entry)))
        const failed = yield* sql
          .withTransaction(
            sql`INSERT INTO child VALUES (1)`.pipe(Effect.andThen(note("phantom")), Effect.asVoid),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(ran).toEqual([])
        expect(yield* sql`SELECT * FROM child`).toEqual([])
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO parent VALUES (1)`
            yield* sql.withTransaction(note("nested"))
            yield* sql.afterCommit(
              sql<{ id: number }>`SELECT id FROM parent`.pipe(
                Effect.orDie,
                Effect.tap((rows) => Effect.sync(() => void ran.push(`read ${rows[0]?.id}`))),
                Effect.asVoid,
              ),
            )
            expect(ran).toEqual([])
          }),
        )
      }),
    )
    expect(ran).toEqual(["nested", "read 1"])
  })

  test("boots the full database layer with migrations over injected storage", async () => {
    const storage = makeDurableObjectStorage()
    const core = await import("@opencode/core/database/database")
    await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          core.Database.layerFromClient.pipe(Layer.provide(sqliteLayer({ storage })), Layer.provide(tempGlobalLayer)),
        ),
      ),
    )
    const names = storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .toArray()
      .map((row) => row.name)
    expect(names).toContain("migration")
    expect(names).toContain("session_v2")
    expect(() => storage.sql.exec("PRAGMA foreign_keys = OFF")).toThrow("not authorized")

    await run(
      storage,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE _parent (id TEXT PRIMARY KEY)`
        yield* sql`CREATE TABLE _child (parent_id TEXT NOT NULL REFERENCES _parent(id) ON DELETE CASCADE)`
        yield* sql`INSERT INTO _parent (id) VALUES (${"p1"})`
        yield* sql`INSERT INTO _child (parent_id) VALUES (${"p1"})`
        yield* sql`DELETE FROM _parent WHERE id = ${"p1"}`
        expect(yield* sql`SELECT * FROM _child`).toEqual([])
      }),
    )
  })
})
