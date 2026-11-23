// Fork feature (synthetic-archived): the database the admission tests run on, one switch for all of them.
import { Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { sqliteLayer } from "@opencode/core/database/sqlite.workerd"
import { makeDurableObjectStorage } from "./durable-object-storage"

/** The driver `OPENCODE_TEST_SQLITE` names: `durable-object`, or bun:sqlite (the default). */
export type Driver = "durable-object" | "bun:sqlite"
export const driver: Driver = process.env.OPENCODE_TEST_SQLITE === "durable-object" ? "durable-object" : "bun:sqlite"

/** The database node's replacement on a named driver (an in-memory database). */
export const databaseOn = (on: Driver) =>
  on === "durable-object"
    ? Database.node.replace(
        Database.configuredClient(Layer.suspend(() => sqliteLayer({ storage: makeDurableObjectStorage() }))),
      )
    : Database.node.replace(Database.configured({ path: ":memory:" }))

/**
 * The database node's replacement. `OPENCODE_TEST_SQLITE=durable-object` runs a test on the Durable Object SQLite
 * client (emulated over bun:sqlite, durable-object-storage.ts): it manages transactions natively and offers no
 * rollback callback, so a test green there needs none. A `file` is a bun:sqlite database file (two processes).
 */
export const database = (file?: string) =>
  file !== undefined ? Database.node.replace(Database.configured({ path: file })) : databaseOn(driver)

/** The database alone, on that driver. */
export const databaseLayer = () => AppNodeBuilder.build(Database.node, [database()])
