import { NodeRuntime } from "@effect/platform-node"
import { Teardown } from "@opencode/util/teardown"
import { Effect } from "effect"
import { ShutdownDeadline } from "../../src/shutdown-deadline"

// Holds ten "watches" whose close blocks this thread for 1 s each, as a node watch's close does while Bun rebuilds its
// FSEventStream against a degraded fseventsd (oven-sh/bun#43870), unless a signal began the shutdown (the watcher's
// release skips them then); then a finalizer that never finishes, so only the deadline ends the process.
const blocker = new Int32Array(new SharedArrayBuffer(4))

Effect.gen(function* () {
  yield* ShutdownDeadline.install(Number(process.argv[2]))
  yield* Effect.addFinalizer(() => Effect.never)
  for (let index = 0; index < 10; index++)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (!Teardown.exiting()) Atomics.wait(blocker, 0, 0, 1000)
      }),
    )
  console.log("SHUTDOWN_READY")
  return yield* Effect.never
}).pipe(Effect.scoped, NodeRuntime.runMain)
