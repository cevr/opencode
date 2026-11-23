/* oxlint-disable */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
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
// routing of the events it wrote), as effect/sql's `afterCommit` does for transactions it opens itself, and work that
// undoes an in-memory effect if the transaction, or the savepoint it was made in, rolls back (`onRollback`). One level
// per transaction or savepoint: a released savepoint hands both lists to its parent; a rolled-back one drops its
// commit work and runs its undo work.
type Level = { readonly commit: Array<Effect.Effect<void>>; readonly rollback: Array<Effect.Effect<void>> }
const afterCommitLevels = new WeakMap<object, Array<Level>>()

function openLevel(connection: object, id: number) {
  if (id === 0) afterCommitLevels.set(connection, [{ commit: [], rollback: [] }])
  else afterCommitLevels.get(connection)?.push({ commit: [], rollback: [] })
}

/** Closes a level; answers the work to run once the connection is released (the commit's, or a rollback's undo, last first). */
function closeLevel(connection: object, id: number, committed: boolean): Array<Effect.Effect<void>> {
  const levels = afterCommitLevels.get(connection)
  if (!levels) return []
  const level = levels.pop() ?? { commit: [], rollback: [] }
  if (id !== 0) {
    const parent = levels.at(-1)
    if (!committed) return level.rollback.toReversed()
    parent?.commit.push(...level.commit)
    parent?.rollback.push(...level.rollback)
    return []
  }
  afterCommitLevels.delete(connection)
  return committed ? level.commit : level.rollback.toReversed()
}

const currentLevel = (client: SqlClient) =>
  Effect.map(Effect.serviceOption(client.transactionService), (option) =>
    option._tag === "Some" ? afterCommitLevels.get(option.value[0])?.at(-1) : undefined,
  )

/**
 * Runs `effect` once the outermost transaction open on the current fiber commits; at once when none is open. Dropped
 * when that transaction, or the savepoint it was registered in, rolls back.
 */
export function afterCommit(client: SqlClient, effect: Effect.Effect<void>): Effect.Effect<void> {
  if (managesTransactionsNatively(client)) return client.afterCommit(effect)
  return Effect.flatMap(currentLevel(client), (level) => {
    if (!level) return effect
    level.commit.push(effect)
    return Effect.void
  })
}

/**
 * Runs `undo` if the transaction open on the current fiber, or the savepoint it is registered in, rolls back; never
 * when it commits, nor when none is open. For an in-memory effect made inside a transaction that only its commit may
 * keep. A natively managed client (Durable Object SQLite) offers no rollback callback: there `undo` is not run.
 */
export function onRollback(client: SqlClient, undo: Effect.Effect<void>): Effect.Effect<void> {
  if (managesTransactionsNatively(client)) return Effect.void
  return Effect.flatMap(currentLevel(client), (level) => {
    if (level) level.rollback.push(undo)
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

  private withTransaction<A, E, R>(effect: Effect.Effect<A, E, R>, config: SQLiteTransactionConfig | undefined) {
    if (managesTransactionsNatively(this.client)) return this.client.withTransaction(effect)
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
                    // committed; a rolled-back level drops that work and runs its undo work.
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
              // Fork (synthetic-archived): after the commit (or the rollback, its undo work) and the connection's release.
              Effect.onExit(() =>
                Effect.forEach(after.splice(0), (work) => Effect.ignoreCause(work), { discard: true }),
              ),
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
