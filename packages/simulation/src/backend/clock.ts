import { Clock, Duration, Effect, Schema } from "effect"

/**
 * The simulated server's clock.
 *
 * It reads the real clock plus an offset that only grows: time keeps flowing
 * on its own, and a driver jumps it forward with `advance`. A sleep wakes at its
 * deadline on this clock, whichever comes first: the real time passing, or an
 * advance past it. The server never stalls on a timer the driver did not
 * advance (a debounce, a retry, a poll), and a driver skips a long wait (a
 * cache lifetime, a reset window) without waiting it out.
 */

export class AdvanceError extends Schema.TaggedError<AdvanceError>()("SimulationClock.AdvanceError", {
  message: Schema.String,
}) {}

export interface Interface {
  /** The clock to provide to the server's fibers. */
  readonly clock: Clock.Clock
  /** Moves the clock forward by `millis`, wakes every sleep it passes, and returns the new time in epoch ms. */
  readonly advance: (millis: number) => Effect.Effect<number, AdvanceError>
}

interface Sleeper {
  readonly deadline: number
  timer: ReturnType<typeof setTimeout> | undefined
  readonly wake: () => void
}

// setTimeout's longest delay; a longer wait sets its timer again when it fires.
const MAX_TIMER_MILLIS = 2 ** 31 - 1
const NANOS_PER_MILLI = 1_000_000n

export const make = Effect.fn("SimulationClock.make")(function* () {
  const base = yield* Clock.clockWith(Effect.succeed)
  let offset = 0
  const sleepers = new Set<Sleeper>()
  const now = () => base.currentTimeMillisUnsafe() + offset

  const arm = (sleeper: Sleeper) => {
    if (sleeper.timer !== undefined) clearTimeout(sleeper.timer)
    const remaining = sleeper.deadline - now()
    if (remaining <= 0) {
      sleepers.delete(sleeper)
      sleeper.timer = undefined
      sleeper.wake()
      return
    }
    sleeper.timer = setTimeout(() => arm(sleeper), Math.min(remaining, MAX_TIMER_MILLIS))
  }

  const sleep = (duration: Duration.Duration): Effect.Effect<void> => {
    const millis = Duration.toMillis(duration)
    if (millis <= 0) return Effect.yieldNow
    if (!Number.isFinite(millis)) return Effect.never
    return Effect.callback<void>((resume) => {
      const sleeper: Sleeper = { deadline: now() + millis, timer: undefined, wake: () => resume(Effect.void) }
      sleepers.add(sleeper)
      arm(sleeper)
      return Effect.sync(() => {
        sleepers.delete(sleeper)
        if (sleeper.timer !== undefined) clearTimeout(sleeper.timer)
      })
    })
  }

  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe() + BigInt(offset) * NANOS_PER_MILLI,
    currentTimeNanos: Effect.sync(() => base.currentTimeNanosUnsafe() + BigInt(offset) * NANOS_PER_MILLI),
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe() + BigInt(offset) * NANOS_PER_MILLI,
    monotonicTimeNanos: Effect.sync(() => base.monotonicTimeNanosUnsafe() + BigInt(offset) * NANOS_PER_MILLI),
    sleep,
  }

  const advance = (millis: number) =>
    Number.isInteger(millis) && millis >= 0
      ? Effect.sync(() => {
          offset += millis
          // Earliest deadline first, so sleeps an advance passes wake in the order they were due.
          for (const sleeper of [...sleepers].sort((a, b) => a.deadline - b.deadline)) arm(sleeper)
          return now()
        })
      : Effect.fail(new AdvanceError({ message: `A clock advance is a whole number of ms, at least 0: ${millis}` }))

  return { clock, advance } satisfies Interface
})

export * as SimulationClock from "./clock"
