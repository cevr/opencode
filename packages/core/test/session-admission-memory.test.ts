// Fork feature (synthetic-archived): a refused admission changes nothing, rows or memory, on every driver. By
// construction: inside the admitting transaction nothing is done in memory that a rollback would have to undo. What the
// transaction decides is read from its rows (the reminder is a row named by its event, plan.ts `reminderID`), and every
// in-memory effect of its events (routes, wakes, listeners, subscribers) is deferred to after the commit (`afterCommit`).
// The refusal/retry behavior is tested in command-selection-gap.test.ts. This narrow architecture check flags direct
// module-level collection allocations in the admission code for review; it is not a proof about all heap writes.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { files } from "./fixture/admission-sites"

const root = path.join(import.meta.dir, "..", "..", "..")
const source = (file: string) => readFileSync(path.join(root, file), "utf8")

const countCollections = (file: string) =>
  [...source(file).matchAll(/^(?:export )?(?:const|let) \w+(?:: [^=]+)? = new (?:Set|WeakSet|Map|WeakMap)\b/gm)].length

describe("the admitting transaction's in-memory state", () => {
  test("admission and Plan do not allocate another module-level Set or Map for a reminder mark", () => {
    expect({
      admission: countCollections("packages/core/src/session/admission.ts"),
      plan: countCollections("packages/core/src/plugin/plan.ts"),
      inbox: countCollections("packages/core/src/session/inbox.ts"),
      synthetic: countCollections("packages/core/src/session/synthetic.ts"),
    }).toEqual({
      // A command extent's own selection (dies with its extent) and the scoped list of plugin reactions.
      admission: 2,
      plan: 0,
      inbox: 0,
      synthetic: 0,
    })
  })

  test("no rollback callback: nothing in core's sources registers undo work for a transaction", () => {
    const found = files(root, "packages/core/src").filter((file) => /\bonRollback\b/.test(source(file)))
    expect(found).toEqual([])
  })
})
