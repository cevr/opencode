/* oxlint-disable */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import type { SqlClient } from "effect/sql/SqlClient"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import { StorageFailure } from "../../storage-failure.js"
import type { EffectCacheShape } from "drizzle-orm/cache/core/cache-effect"
import type { WithCacheConfig } from "drizzle-orm/cache/core/types"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import type { EffectLoggerShape } from "drizzle-orm/effect-core/logger"
import type { QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect"
import { entityKind } from "drizzle-orm/entity"
import type { AnyRelations } from "drizzle-orm/relations"
import type { RelationalQueryMapperConfig } from "drizzle-orm/relations"
import type { Query } from "drizzle-orm/sql/sql"
import type { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
import {
  SQLiteEffectPreparedQuery,
  SQLiteEffectSession,
  SQLiteEffectTransaction,
} from "../sqlite-core/effect/session.js"
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types"
import type { PreparedQueryConfig, SQLiteExecuteMethod, SQLiteTransactionConfig } from "drizzle-orm/sqlite-core/session"

export interface EffectSQLiteQueryEffectHKT extends QueryEffectHKTBase {
  readonly error: EffectDrizzleQueryError
  readonly context: never
}

/**
 * A SqlClient whose runtime rejects SQL transaction statements (BEGIN/COMMIT/SAVEPOINT) and
 * manages transactions natively instead — Cloudflare Durable Object SQLite. Producers set
 * `transactionStatements: false` (see `database/sqlite.workerd.ts`) and the session delegates
 * to the client's `withTransaction` rather than issuing transaction statements.
 */
export interface NativeTransactionSqlClient extends SqlClient {
  readonly transactionStatements: false
}

export function managesTransactionsNatively(client: SqlClient): client is NativeTransactionSqlClient {
  return (client as SqlClient & { readonly transactionStatements?: boolean }).transactionStatements === false
}

// Fork feature (synthetic-archived): work to run once the outermost transaction of a connection commits (the bus's
// routing of the events it wrote), on every driver: effect/sql's own `afterCommit` belongs to the transactions its
// client opens, which a natively managed client (Durable Object SQLite) replaces, so it would run the work at once. One level per
// transaction or savepoint: a released savepoint hands its work to its parent, a rolled-back one drops it.
const afterCommitLevels = new WeakMap<object, Array<Array<Effect.Effect<void>>>>()
// A natively managed connection whose nested transaction failed, with the error its outermost transaction now fails with
// (no savepoints: withNativeTransaction).
const doomed = new WeakMap<object, SqlError>()

/** The error a doomed native transaction fails with, naming the nested failure that doomed it. */
export const nestedTransactionFailed = (cause: Cause.Cause<unknown>) => {
  const inner = Cause.squash(cause)
  const named = inner instanceof Error ? inner.message || inner.name : String(inner)
  return new SqlError({
    reason: new UnknownError({
      cause: inner,
      message: `NestedTransactionFailed: a nested transaction failed (${named}), and this storage cannot roll back only its part`,
      operation: "transaction",
    }),
  })
}

function openLevel(connection: object, id: number) {
  if (id === 0) afterCommitLevels.set(connection, [[]])
  else afterCommitLevels.get(connection)?.push([])
}

/** Closes a level; the outermost one, committed, answers its work, to run once the connection is released. */
function closeLevel(connection: object, id: number, committed: boolean): Array<Effect.Effect<void>> {
  const levels = afterCommitLevels.get(connection)
  if (!levels) return []
  const work = levels.pop() ?? []
  if (id !== 0) {
    if (committed) levels.at(-1)?.push(...work)
    return []
  }
  afterCommitLevels.delete(connection)
  return committed ? work : []
}

/**
 * Runs `effect` once the outermost transaction open on the current fiber commits; at once when none is open. Dropped
 * when that transaction, or the savepoint it was registered in, rolls back.
 */
export function afterCommit(client: SqlClient, effect: Effect.Effect<void>): Effect.Effect<void> {
  return Effect.flatMap(Effect.serviceOption(client.transactionService), (option) => {
    const levels = option._tag === "Some" ? afterCommitLevels.get(option.value[0]) : undefined
    const level = levels?.at(-1)
    if (!level) return effect
    level.push(effect)
    return Effect.void
  })
}

export type EffectSQLiteRunResult = readonly never[]

export interface EffectSQLiteSessionOptions {
  logger: EffectLoggerShape
  cache: EffectCacheShape
  useJitMappers?: boolean
}

export class EffectSQLiteSession<TRelations extends AnyRelations> extends SQLiteEffectSession<
  EffectSQLiteQueryEffectHKT,
  EffectSQLiteRunResult,
  TRelations
> {
  static override readonly [entityKind]: string = "EffectSQLiteSession"

  constructor(
    private client: SqlClient,
    dialect: SQLiteDialect,
    protected relations: TRelations,
    private options: EffectSQLiteSessionOptions,
  ) {
    super(dialect)
  }

  override prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown,
    queryMetadata?: {
      type: "select" | "update" | "delete" | "insert"
      tables: string[]
    },
    cacheConfig?: WithCacheConfig,
  ): SQLiteEffectPreparedQuery<T, EffectSQLiteQueryEffectHKT> {
    return new SQLiteEffectPreparedQuery<T, EffectSQLiteQueryEffectHKT>(
      (params, method) => this.execute(query, params, method),
      query,
      this.options.logger,
      this.options.cache,
      queryMetadata,
      cacheConfig,
      fields,
      executeMethod,
      this.options.useJitMappers,
      customResultMapper,
      undefined,
      undefined,
      this.isInTransaction(),
    )
  }

  override prepareRelationalQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    customResultMapper: (rows: Record<string, unknown>[], mapColumnValue?: (value: unknown) => unknown) => unknown,
    config: RelationalQueryMapperConfig,
  ): SQLiteEffectPreparedQuery<T, EffectSQLiteQueryEffectHKT, true> {
    return new SQLiteEffectPreparedQuery<T, EffectSQLiteQueryEffectHKT, true>(
      (params, method) => this.execute(query, params, method),
      query,
      this.options.logger,
      this.options.cache,
      undefined,
      undefined,
      fields,
      executeMethod,
      this.options.useJitMappers,
      customResultMapper,
      true,
      config,
      this.isInTransaction(),
    )
  }

  private execute(query: Query, params: unknown[], method: SQLiteExecuteMethod | "values") {
    // Fork (synthetic-archived): a doomed native transaction refuses every later statement.
    if (managesTransactionsNatively(this.client))
      return this.doomedStatement().pipe(Effect.andThen(this.executeStatement(query, params, method)))
    return this.executeStatement(query, params, method)
  }

  private executeStatement(query: Query, params: unknown[], method: SQLiteExecuteMethod | "values") {
    const statement = this.client.unsafe(query.sql, params)
    if (method === "values") return statement.values.pipe(Effect.withTracerEnabled(false))
    if (method === "get")
      return statement.withoutTransform.pipe(
        Effect.map((rows) => rows[0]),
        Effect.withTracerEnabled(false),
      )
    return statement.withoutTransform.pipe(Effect.withTracerEnabled(false))
  }

  private isInTransaction() {
    return Effect.serviceOption(this.client.transactionService).pipe(Effect.map((option) => option._tag === "Some"))
  }

  private executeTransactionStatement(connection: Effect.Success<SqlClient["reserve"]>, query: string) {
    return connection.executeUnprepared(query, [], undefined).pipe(Effect.asVoid)
  }

  // Fork (synthetic-archived): a natively managed client's transaction, with the same after-commit levels as the
  // statement path. Durable Object SQLite has no savepoints and rejects a nested transaction, so one opened inside
  // another joins it. Its after-commit work is dropped if it fails, and the outer transaction is doomed: none of it can
  // be undone alone, so every later statement, nested transaction and the commit fail with `NestedTransactionFailed`,
  // even if the caller caught the inner failure, and no after-commit work runs.
  private withNativeTransaction<A, E, R>(client: NativeTransactionSqlClient, effect: Effect.Effect<A, E, R>) {
    return Effect.withFiber<A, E | SqlError, R>((fiber) => {
      const outer = Context.getOption(fiber.context, client.transactionService)
      if (outer._tag === "Some") {
        const [connection, parent] = outer.value
        const id = parent + 1
        const failed = doomed.get(connection)
        if (failed) return Effect.fail(failed)
        return Effect.sync(() => openLevel(connection, id)).pipe(
          Effect.andThen(
            Effect.provideContext(effect, Context.add(fiber.context, client.transactionService, [connection, id])),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              closeLevel(connection, id, Exit.isSuccess(exit))
              if (Exit.isFailure(exit) && !doomed.has(connection))
                doomed.set(connection, nestedTransactionFailed(exit.cause))
            }),
          ),
        )
      }
      const after: Array<Effect.Effect<void>> = []
      return client
        .withTransaction(
          Effect.withFiber<A, E | SqlError, R>((inner) => {
            // The connection the client's own transaction provides (always present inside it).
            const opened = Context.getOption(inner.context, client.transactionService)
            if (opened._tag === "None") return effect
            const [connection] = opened.value
            return Effect.sync(() => openLevel(connection, 0)).pipe(
              Effect.andThen(effect),
              Effect.flatMap((value) => {
                const failed = doomed.get(connection)
                return failed ? Effect.fail(failed) : Effect.succeed(value)
              }),
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  after.push(...closeLevel(connection, 0, Exit.isSuccess(exit)))
                  doomed.delete(connection)
                }),
              ),
            )
          }),
        )
        .pipe(
          // Only once the storage committed: its own commit can still fail after the body succeeded.
          Effect.tap(() => Effect.forEach(after.splice(0), (work) => Effect.ignoreCause(work), { discard: true })),
        )
    })
  }

  /** Fork (synthetic-archived): a doomed native transaction's statements fail (withNativeTransaction). */
  private doomedStatement(): Effect.Effect<void, SqlError> {
    if (!managesTransactionsNatively(this.client)) return Effect.void
    return Effect.flatMap(Effect.serviceOption(this.client.transactionService), (option) => {
      const failed = option._tag === "Some" ? doomed.get(option.value[0]) : undefined
      return failed ? Effect.fail(failed) : Effect.void
    })
  }

  private withTransaction<A, E, R>(effect: Effect.Effect<A, E, R>, config: SQLiteTransactionConfig | undefined) {
    if (managesTransactionsNatively(this.client)) return this.withNativeTransaction(this.client, effect)
    return Effect.uninterruptibleMask((restore) =>
      Effect.withFiber<A, E | SqlError, R>((fiber) => {
        const services = fiber.context
        const connectionOption = Context.getOption(services, this.client.transactionService)
        const connection: Effect.Effect<
          readonly [Scope.Closeable | undefined, Effect.Success<SqlClient["reserve"]>],
          SqlError
        > =
          connectionOption._tag === "Some"
            ? Effect.succeed([undefined, connectionOption.value[0]] as const)
            : Scope.make().pipe(
                Effect.flatMap((scope) =>
                  Scope.provide(this.client.reserve, scope).pipe(
                    Effect.map((connection) => [scope, connection] as const),
                    Effect.catch((error) =>
                      Scope.close(scope, Exit.fail(error)).pipe(Effect.andThen(Effect.fail(error))),
                    ),
                  ),
                ),
              )
        const id = connectionOption._tag === "Some" ? connectionOption.value[1] + 1 : 0
        const after: Array<Effect.Effect<void>> = []

        return connection.pipe(
          Effect.flatMap(([scope, connection]) => {
            const transaction = this.executeTransactionStatement(
              connection,
              id === 0 ? `begin ${config?.behavior ?? "deferred"}` : `savepoint effect_sql_${id}`,
            ).pipe(
              // Fork (synthetic-archived): a level of after-commit work for this transaction or savepoint.
              Effect.tap(() => Effect.sync(() => openLevel(connection, id))),
              Effect.flatMap(() =>
                Effect.provideContext(
                  restore(effect),
                  Context.add(services, this.client.transactionService, [connection, id]),
                ).pipe(
                  Effect.exit,
                  Effect.flatMap((exit) => {
                    const finalize = Exit.isSuccess(exit)
                      ? id === 0
                        ? this.executeTransactionStatement(connection, "commit").pipe(
                            // SQLite keeps the transaction open after deferred constraint commit failures.
                            Effect.catch((error) =>
                              this.executeTransactionStatement(connection, "rollback").pipe(
                                Effect.catch(() => Effect.void),
                                Effect.andThen(Effect.fail(error)),
                              ),
                            ),
                          )
                        : this.executeTransactionStatement(connection, `release savepoint effect_sql_${id}`)
                      : (id === 0
                          ? this.executeTransactionStatement(connection, "rollback")
                          : this.executeTransactionStatement(connection, `rollback to savepoint effect_sql_${id}`).pipe(
                              Effect.andThen(
                                this.executeTransactionStatement(connection, `release savepoint effect_sql_${id}`),
                              ),
                            )
                        ).pipe(
                          // After errors such as SQLITE_FULL, SQLite rolls the whole transaction back itself, so this
                          // rollback has nothing to undo and fails. Report the body's error, not that one. Any other
                          // rollback failure still fails.
                          Effect.catch((error) =>
                            Exit.isFailure(exit) && StorageFailure.rolledBack(exit.cause)
                              ? Effect.void
                              : Effect.fail(error),
                          ),
                        )

                    // Fork (synthetic-archived): run the work registered for after the outermost commit only once it
                    // committed; a rolled-back level drops its own.
                    return finalize.pipe(
                      Effect.onExit((done) =>
                        Effect.sync(() => {
                          after.push(...closeLevel(connection, id, Exit.isSuccess(exit) && Exit.isSuccess(done)))
                        }),
                      ),
                      Effect.flatMap(() => exit),
                    )
                  }),
                ),
              ),
            )

            return (
              scope === undefined ? transaction : transaction.pipe(Effect.onExit((exit) => Scope.close(scope, exit)))
            ).pipe(
              // Fork (synthetic-archived): after the commit and the connection's release, as the bus routed before.
              Effect.tap(() => Effect.forEach(after.splice(0), (work) => Effect.ignoreCause(work), { discard: true })),
            )
          }),
        )
      }),
    )
  }

  override transaction<A, E, R>(
    transaction: (tx: EffectSQLiteTransaction<TRelations>) => Effect.Effect<A, E, R>,
    config?: SQLiteTransactionConfig,
  ): Effect.Effect<A, E | SqlError, R> {
    const { dialect, relations } = this

    return this.withTransaction(
      Effect.gen({ self: this }, function* () {
        const tx = new EffectSQLiteTransaction<TRelations>(dialect, this, relations)

        return yield* transaction(tx)
      }),
      config,
    )
  }
}

export class EffectSQLiteTransaction<TRelations extends AnyRelations> extends SQLiteEffectTransaction<
  EffectSQLiteQueryEffectHKT,
  EffectSQLiteRunResult,
  TRelations
> {
  static override readonly [entityKind]: string = "EffectSQLiteTransaction"

  override transaction: <A, E, R>(
    transaction: (
      tx: SQLiteEffectTransaction<EffectSQLiteQueryEffectHKT, EffectSQLiteRunResult, TRelations>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, SqlError | E, R> = (tx) => this.session.transaction(tx)
}
