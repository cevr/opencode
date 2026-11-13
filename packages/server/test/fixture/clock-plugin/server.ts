import { define } from "@opencode/plugin/effect/plugin"
import { Rpc } from "@opencode/schema/rpc"
import { Clock, Effect, Ref, Schema } from "effect"

/** What the clock probe answers: the server's time as its request fibers read it, and whether its hour-long sleep ended. */
export const ClockProbe = Rpc.define({
  id: "clock-probe",
  methods: {
    read: {
      input: Schema.Struct({}),
      output: Schema.Struct({ now: Schema.Number, woke: Schema.Boolean }),
    },
  },
  events: {},
})

/** A plugin that sleeps an hour on the server's clock from its setup, and answers `clock-probe/read`. */
export default define({
  id: "clock-probe",
  effect: (ctx) =>
    Effect.gen(function* () {
      const woke = yield* Ref.make(false)
      yield* Effect.sleep("1 hour").pipe(Effect.andThen(Ref.set(woke, true)), Effect.forkScoped)
      yield* ctx.rpc
        .register(ClockProbe, {
          read: () =>
            Effect.gen(function* () {
              return { now: yield* Clock.currentTimeMillis, woke: yield* Ref.get(woke) }
            }),
        })
        .pipe(Effect.orDie)
    }),
})
