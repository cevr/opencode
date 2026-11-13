export * as SubagentJob from "./subagent-job.js"

import { Context, Effect, Layer } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Job } from "../job.js"
import { SessionExecution } from "./execution.js"
import type { SessionRunner } from "./runner/index.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

export interface Interface {
  readonly start: (recovery: Recovery) => Effect.Effect<Job.Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

/** Starts a child on a new task: new work, so it ends a stop of the child. */
export function start(jobs: Job.Interface, execution: SessionExecution.Interface, recovery: Recovery) {
  return run(jobs, execution, execution.resume(recovery.childSessionID), recovery)
}

/**
 * Restarts the job of a child a dead server left running, continuing its claimed turn. Not new work: it never ends
 * a stop of the child.
 */
export function restart(
  jobs: Job.Interface,
  execution: SessionExecution.Interface,
  recovery: Recovery,
  notificationID: Job.Background["notificationID"],
) {
  return run(jobs, execution, execution.recover(recovery.childSessionID), recovery, notificationID)
}

function run(
  jobs: Job.Interface,
  execution: SessionExecution.Interface,
  turn: Effect.Effect<void, SessionRunner.RunError>,
  recovery: Recovery,
  notificationID?: Job.Background["notificationID"],
) {
  const id = recovery.childSessionID
  return jobs.start({
    id,
    type: "subagent",
    title: recovery.description,
    metadata: notificationID === undefined ? {} : undefined,
    recovery,
    notificationID,
    background: true,
    run: turn.pipe(
      // Only an explicit caller cancel releases the child's claim. A server shutdown
      // interrupts this job but must leave the child resumable on the next start.
      Effect.onInterrupt(() =>
        jobs.isCancelled(id).pipe(Effect.flatMap((cancelled) => (cancelled ? execution.interrupt(id) : Effect.void))),
      ),
      Effect.as(""),
    ),
  })
}

const make = Effect.gen(function* () {
  const execution = yield* SessionExecution.Service
  const jobs = yield* Job.Service
  // Jobs outlive the plugin that launched them. Fork with the global context too, rather
  // than retaining the caller's location.
  const context = yield* Effect.context<never>()

  return Service.of({
    start: (recovery) => start(jobs, execution, recovery).pipe(Effect.setContext(context)),
  })
})

export const layer = Layer.effect(Service, make)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionExecution.node, Job.node],
})
