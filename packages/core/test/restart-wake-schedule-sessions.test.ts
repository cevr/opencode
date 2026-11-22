// Fork feature (shell-restart-wake): two sessions, each with one shell the restart killed, over every ordering of a
// boot's events (the scheduler and its properties: fixture/restart-wake-schedule.ts), with work given to the first
// meanwhile. No notice reaches the other session, each is delivered once, and a crash between the two shells' steps
// leaves two independent marks.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { crashes, interleavings, it, runAll, sweep } from "./fixture/restart-wake-schedule"

describe("RestartWake over every ordering, two sessions", () => {
  it.live(
    "two sessions, one recovered shell each: no cross-delivery, each woken once, marks independent across a crash",
    () =>
      Effect.gen(function* () {
        const orders = [...interleavings(sweep(2), ["U", "L", "T"]), sweep(2)]
        const scenarios = crashes(orders).map((s) => ({ ...s, owners: [0, 1] }))
        const { ran, failures } = yield* runAll("sessions", scenarios)
        expect(failures).toEqual([])
        expect(ran).toBe(scenarios.length)
      }),
    240_000,
  )
})
