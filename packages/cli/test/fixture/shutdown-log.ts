import { NodeFileSystem, NodeRuntime } from "@effect/platform-node"
import { Logging } from "@opencode/util/observability/logging"
import { Effect, Logger } from "effect"
import { ShutdownDeadline } from "../../src/shutdown-deadline"

// Logs to the file logger at argv[2] with a shutdown deadline of argv[3] ms. `hang`: a finalizer that never finishes,
// announced on stdout when teardown reaches it; `exit`: process.exit right after logging, with no teardown at all;
// `through`: Logging.writeThroughFromNow right after logging, then idle until killed.
const [target = "", deadline = "60000", mode = "hang"] = process.argv.slice(2)

Effect.gen(function* () {
  yield* ShutdownDeadline.install(Number(deadline))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => console.log("SHUTDOWN_TEARDOWN")).pipe(Effect.andThen(Effect.never)),
  )
  yield* Effect.logInfo("logged before the signal")
  if (mode === "exit") process.exit(0)
  if (mode === "through") Logging.writeThroughFromNow()
  console.log("SHUTDOWN_READY")
  return yield* Effect.never
}).pipe(
  Effect.scoped,
  // An hour's batch: no timer writes a line here, so each one on disk was written by the path under test.
  Effect.provide(Logger.layer([Logging.fileLogger(target, undefined, "1 hour")], { mergeWithExisting: false })),
  Effect.provide(NodeFileSystem.layer),
  Effect.orDie,
  NodeRuntime.runMain,
)
