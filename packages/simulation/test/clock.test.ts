import { expect, test } from "bun:test"
import { Clock, Duration, Effect, Fiber } from "effect"
import { SimulationClock } from "../src/backend/clock"

const HOUR = Duration.toMillis(Duration.hours(1))

const run = <A, E>(body: (clock: SimulationClock.Interface) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* SimulationClock.make()
      return yield* body(clock).pipe(Effect.provideService(Clock.Clock, clock.clock))
    }),
  )

test("an advance moves the time every reading sees, and real time keeps flowing", async () => {
  await run((clock) =>
    Effect.gen(function* () {
      const before = yield* Clock.currentTimeMillis
      const nanos = yield* Clock.currentTimeNanos
      const monotonic = yield* Clock.monotonicTimeNanos
      const now = yield* clock.advance(HOUR)
      expect(now).toBeGreaterThanOrEqual(before + HOUR)
      expect(yield* Clock.currentTimeMillis).toBeGreaterThanOrEqual(now)
      expect((yield* Clock.currentTimeNanos) - nanos).toBeGreaterThanOrEqual(BigInt(HOUR) * 1_000_000n)
      expect((yield* Clock.monotonicTimeNanos) - monotonic).toBeGreaterThanOrEqual(BigInt(HOUR) * 1_000_000n)
      // Real time is not frozen: a short sleep wakes by itself.
      yield* Effect.sleep("20 millis").pipe(Effect.timeout("5 seconds"))
    }),
  )
})

test("a sleep wakes as soon as an advance passes its deadline, not in real time", async () => {
  await run((clock) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const sleeper = yield* Effect.sleep("1 hour").pipe(Effect.andThen(Clock.currentTimeMillis), Effect.forkChild)
      yield* Effect.yieldNow
      yield* clock.advance(HOUR)
      const woke = yield* Fiber.join(sleeper).pipe(Effect.timeout("5 seconds"))
      expect(woke - start).toBeGreaterThanOrEqual(HOUR)
    }),
  )
})

test("an advance short of a deadline leaves the sleep waiting, and a second one past it wakes it", async () => {
  await run((clock) =>
    Effect.gen(function* () {
      const sleeper = yield* Effect.sleep("1 hour").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* clock.advance(HOUR - 60_000)
      yield* Effect.sleep("50 millis")
      expect(sleeper.pollUnsafe()).toBeUndefined()
      yield* clock.advance(60_000)
      yield* Fiber.join(sleeper).pipe(Effect.timeout("5 seconds"))
    }),
  )
})

test("sleeps wake in the order of their deadlines, and an interrupted one is dropped", async () => {
  await run((clock) =>
    Effect.gen(function* () {
      const order: Array<string> = []
      const late = yield* Effect.sleep("2 hours").pipe(
        Effect.andThen(Effect.sync(() => order.push("late"))),
        Effect.forkChild,
      )
      const early = yield* Effect.sleep("1 hour").pipe(
        Effect.andThen(Effect.sync(() => order.push("early"))),
        Effect.forkChild,
      )
      const dropped = yield* Effect.sleep("1 hour").pipe(
        Effect.andThen(Effect.sync(() => order.push("dropped"))),
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(dropped)
      yield* clock.advance(3 * HOUR)
      yield* Fiber.join(late).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.join(early).pipe(Effect.timeout("5 seconds"))
      expect(order).toEqual(["early", "late"])
    }),
  )
})

test("a negative advance is refused", async () => {
  await run((clock) =>
    Effect.gen(function* () {
      const exit = yield* clock.advance(-1).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})
