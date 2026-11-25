import { Cause, Context, Effect, Exit, Layer, Semaphore, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient, Statement } from "effect/sql"
import type { Connection } from "effect/sql/SqlConnection"
import { classifySqliteError, SqlError, UnknownError } from "effect/sql/SqlError"
import type { NativeTransactionSqlClient } from "./drizzle/effect-sqlite/session.js"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@opencode/core/database/SqliteWorkerd" as const
type TypeId = typeof TypeId

// Durable Object SQLite only allowlists introspection pragmas; journal_mode,
// synchronous, busy_timeout and cache_size all throw, and foreign keys are
// already enforced by default (SQLITE_DEFAULT_FOREIGN_KEYS=1).
export const supportsTuningPragmas = false

// Durable Object SQLite rejects `PRAGMA foreign_keys`: enforcement is always
// on (SQLITE_DEFAULT_FOREIGN_KEYS=1) and only `defer_foreign_keys` is
// allowlisted for migrations that must relax checking inside a transaction.
export const supportsForeignKeyToggle = false

// Minimal structural types for the Durable Object storage API so this adapter
// does not depend on @cloudflare/workers-types (whose ambient globals conflict
// with @types/bun). Shapes match the SqlStorage and DurableObjectStorage docs.
type SqlStorageValue = ArrayBuffer | string | number | null

interface SqlStorageCursor {
  readonly columnNames: Array<string>
  raw(): IterableIterator<Array<SqlStorageValue>>
  toArray(): Array<Record<string, SqlStorageValue>>
}

export interface SqlStorage {
  exec(query: string, ...bindings: Array<unknown>): SqlStorageCursor
}

export interface DurableObjectStorage {
  readonly sql: SqlStorage
  transaction<T>(closure: (txn: { rollback(): void }) => Promise<T>): Promise<T>
  transactionSync<T>(closure: () => T): T
  setAlarm(scheduledTime: number | Date): Promise<void>
}

interface SqliteClient extends SqlClient.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly updateValues: never
}

interface Config {
  readonly storage: DurableObjectStorage
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

type Transaction = {
  readonly after: Array<Effect.Effect<void>>
  open: boolean
  failed?: SqlError
}

const transactionError = (cause: unknown, message: string) =>
  new SqlError({
    reason: new UnknownError({ cause, message, operation: "transaction" }),
  })

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = options.storage

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    // SqlClient.SafeIntegers is ignored: Durable Object SQLite has no bigint
    // mode and always returns integers as numbers. Blobs come back as
    // ArrayBuffer and are normalized to Uint8Array to match the other adapters.
    function* runIterator(query: string, params: ReadonlyArray<unknown> = []) {
      const cursor = native.sql.exec(query, ...params)
      const columns = cursor.columnNames
      for (const row of cursor.raw()) {
        const record: Record<string, unknown> = {}
        for (let i = 0; i < columns.length; i++) {
          const value = row[i]
          record[columns[i]] = value instanceof ArrayBuffer ? new Uint8Array(value) : value
        }
        yield record
      }
    }

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.try({
        try: () => Array.from(runIterator(query, params)),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
          }),
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.try({
        try: () =>
          Array.from(native.sql.exec(query, ...params).raw(), (row) =>
            row.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)),
          ),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
          }),
      })

    const checked = <A>(effect: Effect.Effect<A, SqlError>) =>
      Effect.flatMap(Effect.serviceOption(nativeTransaction), (option) => {
        if (option._tag === "None") return effect
        const failed = unavailable(option.value)
        return failed ? Effect.fail(failed) : effect
      })

    const connection: Connection = {
      execute: (query, params, transformRows) =>
        checked(transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)),
      executeRaw: (query, params) => checked(run(query, params)),
      executeValues: (query, params) => checked(runValues(query, params)),
      executeValuesUnprepared: (query, params) => checked(runValues(query, params)),
      executeUnprepared: (query, params, transformRows) =>
        checked(transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)),
      executeStream: () => Stream.die("executeStream not implemented"),
    }

    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
      Effect.as(restore(semaphore.takeScoped(1)), connection),
    )

    const client = (yield* SqlClient.make({
      acquirer,
      compiler,
      transactionAcquirer,
      driver: "sqlite-do",
      spanAttributes: [
        ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
        [ATTR_DB_SYSTEM_NAME, "sqlite"],
      ],
      transformRows,
    })) as SqliteClient
    const transactionService = client.transactionService
    const nativeTransaction = Context.Service<Transaction>(`${transactionService.key}/workerd`)
    const ended = "Durable Object SQLite transaction has already ended"
    const unavailable = (state: Transaction) =>
      state.failed ?? (state.open ? undefined : transactionError(undefined, ended))

    // Fork (synthetic-archived): without savepoints, both SQL client and Drizzle
    // nesting join the native transaction. A failed inner write dooms the whole
    // unit, even if the outer body catches it.
    const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
      Effect.flatMap(Effect.serviceOption(nativeTransaction), (outer) => {
        if (outer._tag === "Some") {
          const state = outer.value
          const failed = unavailable(state)
          if (failed) return Effect.fail(failed)
          return Effect.onExit(effect, (exit) =>
            Effect.sync(() => {
              if (Exit.isSuccess(exit) || state.failed) return
              const inner = Cause.squash(exit.cause)
              const name = inner instanceof Error ? inner.message || inner.name : String(inner)
              state.failed = transactionError(
                inner,
                `NestedTransactionFailed: a nested transaction failed (${name}), and this storage cannot roll back only its part`,
              )
            }),
          )
        }
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const state: Transaction = { open: true, after: [] }
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                yield* restore(semaphore.takeScoped(1))
                // Native storage holds the transaction open until its callback returns.
                // Its promise, not the body's success, decides whether the commit happened.
                const ready = Promise.withResolvers<Exit.Exit<void, SqlError>>()
                const done = Promise.withResolvers<boolean>()
                const settled = Promise.resolve()
                  .then(() =>
                    native.transaction(async (txn) => {
                      ready.resolve(Exit.void)
                      if (!(await done.promise)) txn.rollback()
                    }),
                  )
                  .then(
                    () => Exit.void,
                    (cause) => {
                      const failure = Exit.fail(
                        new SqlError({
                          reason: classifySqliteError(cause, { message: "Failed transaction", operation: "transaction" }),
                        }),
                      )
                      ready.resolve(failure)
                      return failure
                    },
                  )
                yield* Effect.flatten(Effect.promise(() => ready.promise))
                const exit = yield* restore(effect).pipe(
                  Effect.provideService(nativeTransaction, state),
                  Effect.provideService(transactionService, [connection, 0]),
                  Effect.flatMap((value) => (state.failed ? Effect.fail(state.failed) : Effect.succeed(value))),
                  Effect.exit,
                )
                state.open = false
                done.resolve(Exit.isSuccess(exit))
                return yield* Effect.onExit(exit, () => Effect.flatten(Effect.promise(() => settled)))
              }),
            )
            yield* Effect.forEach(state.after.splice(0), (work) => Effect.ignoreCause(work), { discard: true })
            return result
          }),
        )
      })

    const afterCommit: SqlClient.SqlClient["afterCommit"] = <R>(effect: Effect.Effect<void, never, R>) =>
      Effect.withFiber((fiber) => {
        const state = Context.getOrUndefined(fiber.context, nativeTransaction)
        if (!state) return Effect.ignoreCause(effect)
        if (!state.open) return Effect.die(new Error(ended))
        // Capture the registering fiber's services, but never the finished transaction.
        const context = Context.omit(nativeTransaction, transactionService)(fiber.context) as Context.Context<R>
        state.after.push(Effect.provideContext(effect, context))
        return Effect.void
      })

    return Object.assign(client, {
      [TypeId]: TypeId,
      config: options,
      withTransaction,
      afterCommit,
      // Durable Object SQLite rejects BEGIN/COMMIT/SAVEPOINT; consumers such
      // as the drizzle session detect this and route through withTransaction.
      transactionStatements: false,
    } as const) satisfies NativeTransactionSqlClient
  })

// Defends against the shared path-based Database.layer, which passes a
// filename instead of storage when resolved under the workerd condition.
export const sqliteLayer = (config: Config): Layer.Layer<SqlClient.SqlClient> =>
  config.storage
    ? Layer.effect(SqlClient.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer))
    : Layer.effect(
        SqlClient.SqlClient,
        Effect.die(
          new Error(
            "workerd sqlite cannot open a database from a path; use Database.layerFromClient.pipe(Layer.provide(sqliteLayer({ storage })))",
          ),
        ),
      )

// Durable Object SQLite throws a plain Error without SQLite result codes.
export const resultCode = (_cause: unknown): number | undefined => undefined
