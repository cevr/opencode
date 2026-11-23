// Fork feature (synthetic-archived): a refused admission changes nothing, rows or memory, on every driver. By
// construction: inside the admitting transaction nothing is done in memory that a rollback would have to undo. What the
// transaction decides is read from its rows (the reminder is a row named by its event, plan.ts `reminderID`), and every
// in-memory effect of its events (routes, wakes, listeners, subscribers) is deferred to after the commit (`afterCommit`).
// This file holds the module state that design allows to the code that runs inside the transaction: a new collection
// there (an "already written" mark, a cache) is a change to review, and no rollback callback may come back.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { files } from "./fixture/admission-sites"

const root = path.join(import.meta.dir, "..", "..", "..")
const source = (file: string) => readFileSync(path.join(root, file), "utf8")

/** The names of a file's module-level collections (`const name = new Set|Map|WeakMap…` at column 0). */
const collections = (file: string) =>
  [...source(file).matchAll(/^(?:export )?const (\w+)(?:: [^=]+)? = new (?:Set|Map|WeakMap)\b/gm)].map(
    (match) => match[1],
  )

describe("the admitting transaction's in-memory state", () => {
  test("the module state of the code it runs is what the design allows, and none of it is a per-admission mark", () => {
    expect({
      admission: collections("packages/core/src/session/admission.ts"),
      plan: collections("packages/core/src/plugin/plan.ts"),
      inbox: collections("packages/core/src/session/inbox.ts"),
      synthetic: collections("packages/core/src/session/synthetic.ts"),
      drizzle: collections("packages/core/src/database/drizzle/effect-sqlite/session.ts"),
    }).toEqual({
      // `pending`: a command extent's own selection (dies with the extent); `reactions`: who listens (plugin load).
      admission: ["pending", "reactions"],
      plan: [],
      inbox: [],
      synthetic: [],
      // Transaction-local: the after-commit levels and a native transaction's doom, deleted when the outermost level
      // closes, either way.
      drizzle: ["afterCommitLevels", "doomed"],
    })
  })

  test("no rollback callback: nothing in core's sources registers undo work for a transaction", () => {
    const found = files(root, "packages/core/src").filter((file) => /\bonRollback\b/.test(source(file)))
    expect(found).toEqual([])
  })
})
