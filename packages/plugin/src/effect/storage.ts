import type { Effect, Schema } from "effect"
import type { StorageScanOptions, StorageScanResult } from "../storage.js"

export interface StorageDomain {
  readonly get: (key: string) => Effect.Effect<Schema.Json | undefined>
  readonly set: (key: string, value: Schema.Json) => Effect.Effect<void>
  /** Write only if the stored value's `rev` is `rev` (none counts as 0), or with no `rev` only if absent: whether it was written. */
  readonly setIf: (key: string, value: Schema.Json, rev?: number) => Effect.Effect<boolean>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly scan: (options: StorageScanOptions) => Effect.Effect<StorageScanResult>
}
