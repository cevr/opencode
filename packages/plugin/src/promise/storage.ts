import type { Schema } from "effect"
import type { StorageScanOptions, StorageScanResult } from "../storage.js"

export interface StorageDomain {
  readonly get: (key: string) => Promise<Schema.Json | undefined>
  readonly set: (key: string, value: Schema.Json) => Promise<void>
  /** Write only if the stored value's `rev` is `rev` (none counts as 0), or with no `rev` only if absent: whether it was written. */
  readonly setIf: (key: string, value: Schema.Json, rev?: number) => Promise<boolean>
  readonly remove: (key: string) => Promise<void>
  readonly scan: (options: StorageScanOptions) => Promise<StorageScanResult>
}
