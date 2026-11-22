// Fork feature (shell-restart-wake): the restart's recovered shell notices of one session over every ordering of a
// boot's events (the scheduler and its properties: fixture/restart-wake-schedule.ts).
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { crashes, interleavings, it, runAll, sweep } from "./fixture/restart-wake-schedule"

describe("RestartWake over every ordering of a boot's events", () => {
  for (const shells of [1, 2])
    it.live(
      `${shells} recovered shell${shells === 1 ? "" : "s"} of one session: no lost wake, no doubled notice`,
      () =>
        Effect.gen(function* () {
          const orders = [...interleavings(sweep(shells), ["U", "L", "T"]), sweep(shells)]
          const scenarios = crashes(orders).map((s) => ({ ...s, owners: Array.from({ length: shells }, () => 0) }))
          const { ran, failures } = yield* runAll(`one${shells}`, scenarios)
          expect(failures).toEqual([])
          expect(ran).toBe(scenarios.length)
        }),
      240_000,
    )
})
