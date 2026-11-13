import { Logging } from "@opencode/util/observability/logging"
import { Teardown } from "@opencode/util/teardown"
import { Duration, Effect } from "effect"

/** After SIGTERM or SIGINT, teardown gets this long before the process reports what it is stuck on and exits. */
export const DEADLINE = Duration.seconds(10)

/**
 * Bounds signal-initiated teardown. NodeRuntime.runMain interrupts the main fiber on SIGTERM or SIGINT and then waits
 * for every finalizer, so a finalizer that never finishes would keep the process alive until something kills it.
 * A second signal during teardown reports and exits at once.
 */
export const install = Effect.fnUntraced(function* (input: Duration.Input = DEADLINE) {
  const deadline = Duration.fromInputUnsafe(input)
  const fork = Effect.runForkWith(yield* Effect.context<never>())
  let started = false
  const expire = (signal: NodeJS.Signals) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("shutdown started", { signal })
      yield* Effect.sleep(deadline)
      const pending = Teardown.pending()
      process.stderr.write(report(`shutdown did not finish within ${Duration.format(deadline)}`, pending))
      yield* Effect.logError("shutdown deadline exceeded", {
        deadline: Duration.format(deadline),
        pending: pending.map((item) => `${item.label} for ${item.ms}ms`),
      })
      yield* Effect.sync(() => process.exit(1))
    })
  const onSignal = (signal: NodeJS.Signals) => {
    if (started) {
      process.stderr.write(report(`received ${signal} again during shutdown`, Teardown.pending()))
      process.exit(1)
    }
    started = true
    // Before teardown starts: a parent that kills this process after its grace (the standalone server's, 3 s) would
    // otherwise take the file log's last batch with it.
    Logging.writeThroughFromNow()
    fork(expire(signal))
  }
  // Closing the terminal sends SIGHUP, whose default action exits without teardown. Treat it as SIGTERM, but only
  // with a terminal: nohup and the background service have none, and a listener would override nohup's ignore.
  const onHangup = () => process.kill(process.pid, "SIGTERM")
  const hangup = process.stdin.isTTY || process.stdout.isTTY
  const off = () => {
    process.off("SIGTERM", onSignal)
    process.off("SIGINT", onSignal)
    process.off("SIGHUP", onHangup)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      // Ahead of runMain's own listener, whose interrupt can run teardown's first finalizers before later listeners.
      process.prependListener("SIGTERM", onSignal)
      process.prependListener("SIGINT", onSignal)
      if (hangup) process.on("SIGHUP", onHangup)
    }),
    // Once shutdown has started, keep listening: this release can run while a later finalizer is still stuck.
    () =>
      Effect.sync(() => {
        if (!started) off()
      }),
  )
})

function report(reason: string, pending: ReturnType<typeof Teardown.pending>) {
  const lines = pending.map((item) => `  ${(item.ms / 1000).toFixed(1)}s  ${item.label}`)
  return [
    `${reason}; exiting. Still pending:`,
    ...(lines.length > 0 ? lines : ["  nothing tracked; the stuck finalizer is outside any LayerNode layer"]),
    "",
  ].join("\n")
}

export * as ShutdownDeadline from "./shutdown-deadline"
