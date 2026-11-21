export * as KV from "./kv.js"

import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KVTable } from "./kv/sql.js"

export type Value = Schema.Json

export interface Entry {
  readonly key: string
  readonly value: Value
}

export interface ScanOptions {
  readonly prefix: string
  readonly after?: string
  readonly limit?: number
}

export interface ScanResult {
  readonly entries: readonly Entry[]
  readonly next?: string
}

export interface Interface {
  readonly get: (key: string) => Effect.Effect<Value | undefined>
  readonly set: (key: string, value: Value) => Effect.Effect<void>
  /**
   * Write `value` only if the stored value is the one the caller read, in one statement (atomic across connections
   * and processes under SQLite's write lock); whether it was written. `rev` names what was read: the stored value's
   * numeric `rev` field (a stored value without one counts as 0), or `undefined` for a key that was absent, so the
   * write is an insert only if it still is. The caller keeps `rev` in `value` and raises it on each write.
   */
  readonly setIf: (key: string, value: Value, rev?: number) => Effect.Effect<boolean>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly scan: (options: ScanOptions) => Effect.Effect<ScanResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KV") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return Service.of({
      get: Effect.fn("KV.get")(function* (key) {
        return (yield* db
          .select({ value: KVTable.value })
          .from(KVTable)
          .where(eq(KVTable.key, key))
          .get()
          .pipe(Effect.orDie))?.value
      }),
      set: Effect.fn("KV.set")(function* (key, value) {
        yield* db
          .insert(KVTable)
          .values({ key, value })
          .onConflictDoUpdate({ target: KVTable.key, set: { value, time_updated: Date.now() } })
          .run()
          .pipe(Effect.orDie)
      }),
      setIf: Effect.fn("KV.setIf")(function* (key, value, rev) {
        if (rev === undefined) {
          const inserted = yield* db
            .insert(KVTable)
            .values({ key, value })
            .onConflictDoNothing({ target: KVTable.key })
            .returning({ key: KVTable.key })
            .all()
            .pipe(Effect.orDie)
          return inserted.length === 1
        }
        const updated = yield* db
          .update(KVTable)
          .set({ value, time_updated: Date.now() })
          .where(and(eq(KVTable.key, key), sql`coalesce(json_extract(${KVTable.value}, '$.rev'), 0) = ${rev}`))
          .returning({ key: KVTable.key })
          .all()
          .pipe(Effect.orDie)
        return updated.length === 1
      }),
      remove: Effect.fn("KV.remove")(function* (key) {
        yield* db.delete(KVTable).where(eq(KVTable.key, key)).run().pipe(Effect.orDie)
      }),
      scan: Effect.fn("KV.scan")(function* (options) {
        const limit = Number.isNaN(options.limit) ? 100 : Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 1000)
        const end = prefixEnd(options.prefix)
        const rows = yield* db
          .select({ key: KVTable.key, value: KVTable.value })
          .from(KVTable)
          .where(
            and(
              options.prefix === "" ? undefined : gte(KVTable.key, options.prefix),
              end === undefined ? undefined : lt(KVTable.key, end),
              options.after === undefined ? undefined : gt(KVTable.key, options.after),
            ),
          )
          .orderBy(asc(KVTable.key))
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie)
        const entries = rows.slice(0, limit)
        if (rows.length <= limit) return { entries }
        return { entries, next: entries[entries.length - 1].key }
      }),
    })
  }),
)

function prefixEnd(prefix: string) {
  const points = Array.from(prefix)
  const index = points.findLastIndex((value) => value.codePointAt(0)! < 0x10ffff)
  if (index < 0) return undefined
  return `${points.slice(0, index).join("")}${String.fromCodePoint(points[index].codePointAt(0)! + 1)}`
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
