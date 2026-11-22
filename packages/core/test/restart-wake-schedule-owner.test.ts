// Fork feature (shell-restart-wake): what the owner does while the restart recovers a session's shell, over every
// ordering (the scheduler and its properties: fixture/restart-wake-schedule.ts). The owner archives the session
// (`X`) between any two events of the boot; the user interrupts the turn the session is running (`I`, the TUI's Esc),
// before or after its inbox check; or the user stops the session (`P`, Session.stop) between any two events. An
// archived or stopped session is never woken, its mark is retired, and its notice waits for the next prompt (unarchiving
// does not wake it); an interrupt loses no owed wake and doubles none.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { crashes, inserted, interleavings, it, runAll, sweep } from "./fixture/restart-wake-schedule"

describe("RestartWake over every ordering, with the owner acting meanwhile", () => {
  it.live(
    "an archive anywhere: never woken after it, its mark retired",
    () =>
      Effect.gen(function* () {
        const orders = inserted([...interleavings(sweep(1), ["U", "L", "T"]), sweep(1)], "X")
        const scenarios = crashes(orders).map((s) => ({ ...s, owners: [0] }))
        const { ran, failures } = yield* runAll("archive", scenarios)
        expect(failures).toEqual([])
        expect(ran).toBe(scenarios.length)
      }),
    240_000,
  )

  it.live(
    "an interrupt of the running turn before or after its check: the owed wake still fires once",
    () =>
      Effect.gen(function* () {
        const orders = [...interleavings(sweep(1), ["U", "I"]), ...interleavings(sweep(1), ["U", "L", "I"])]
        const scenarios = crashes(orders).map((s) => ({ ...s, owners: [0] }))
        const { ran, failures } = yield* runAll("interrupt", scenarios)
        expect(failures).toEqual([])
        expect(ran).toBe(scenarios.length)
      }),
    240_000,
  )

  it.live(
    "a stop anywhere, of the running turn or the idle session: never woken after it, the next prompt takes the notice",
    () =>
      Effect.gen(function* () {
        const orders = [
          ...inserted([sweep(1)], "P"),
          ...interleavings(sweep(1), ["U", "P"]),
          ...interleavings(sweep(1), ["U", "L", "P"]),
        ]
        const scenarios = crashes(orders).map((s) => ({ ...s, owners: [0] }))
        const { ran, failures } = yield* runAll("stop", scenarios)
        expect(failures).toEqual([])
        expect(ran).toBe(scenarios.length)
      }),
    240_000,
  )
})
