// Fork feature (synthetic-archived): every source of non-user input, the user's own input and command, and the owner's
// archive, unarchive, stop and delete, over orderings of one and two sessions (the scheduler and its properties:
// fixture/admission-model.ts). 572 orderings: 420 for one session (each of the 10 admissions put at every position of
// 13 control sequences), 62 held-input ones, 90 for two sessions.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ADMITS, interleavings, it, runAll } from "./fixture/admission-model"

/** `event` put at every position of each order. */
const inserted = (orders: readonly string[][], event: string) =>
  orders.flatMap((order) =>
    Array.from({ length: order.length + 1 }, (_, at) => [...order.slice(0, at), event, ...order.slice(at)]),
  )

const CONTROLS = [
  [],
  ["X"],
  ["X", "Y"],
  ["U", "T"],
  ["U", "X", "T"],
  ["X", "U", "T"],
  ["U", "T", "X"],
  ["X", "Y", "U", "T"],
  ["U", "X", "Y", "T"],
  ["P"],
  ["X", "P", "Y"],
  ["D"],
  ["X", "D"],
]

describe("SessionAdmission over orderings", () => {
  it.live(
    "one session: each source's input against archive, unarchive, the user's turn, stop and delete",
    () =>
      Effect.gen(function* () {
        const orders = ADMITS.flatMap((admit) => inserted(CONTROLS, admit))
        const { ran, failures } = yield* runAll("one", orders)
        expect(failures).toEqual([])
        expect(ran).toBe(orders.length)
      }),
    240_000,
  )

  it.live(
    "one session: a held input never starts a turn: not by unarchive, a second held input, a refused plugin, the restart's wake",
    () =>
      Effect.gen(function* () {
        const orders = [
          ...interleavings(["A:restart", "W"], ["X", "Y"]),
          ...interleavings(["A:shell", "A:restart", "W"], ["X", "Y"]),
          ...interleavings(["A:subagent", "A:plugin"], ["X", "Y"]),
          ...interleavings(["A:job", "A:media"], ["X", "Y", "U", "T"]),
          ...interleavings(["A:plugin", "A:shell"], ["X", "Y", "U", "T"]),
          ...interleavings(["A:restart", "W"], ["P", "U", "T"]),
        ]
        const { ran, failures } = yield* runAll("held", orders)
        expect(failures).toEqual([])
        expect(ran).toBe(orders.length)
      }),
    240_000,
  )

  it.live(
    "two sessions: one archived, input to both, the user's command on one admitting to the other",
    () =>
      Effect.gen(function* () {
        const orders = [
          ...interleavings(["X", "L", "K", "F"], ["A:plugin@1", "U@1", "T@1"]),
          ...interleavings(["X", "A:shell", "Y"], ["A:http@1", "L@1", "K@1"]),
          ...interleavings(["U", "X", "T"], ["X@1", "K@1", "A:restart@1", "W@1"]),
        ]
        const { ran, failures } = yield* runAll("two", orders)
        expect(failures).toEqual([])
        expect(ran).toBe(orders.length)
      }),
    240_000,
  )
})
