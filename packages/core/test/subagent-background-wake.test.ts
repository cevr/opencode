import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { LanguageModel, type LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Tool } from "@opencode/core/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

// A subagent that backgrounds a shell and ends its turn is not finished: the shell's notice
// wakes it, and the parent must get the answer it writes then, not the one it wrote while waiting.

const llmLayer = TestLLM.testLayer()
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(LayerNode.group([Bus.node, Session.node, Job.node, LocationServiceMap.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      LayerNodePlatform.llmClient.replace(llmLayer),
      SessionRunnerModel.node.replace(
        Layer.succeed(SessionRunnerModel.Service, {
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: "child", provider: "test", route: OpenAIChat.route }),
                {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 200_000, output: 32_000 },
                },
              ),
            ),
        }),
      ),
    ]),
  ),
)

const WAITING = "Waiting on the shell."
const FINAL = "Final answer, written after the shell finished."
const CANCELLED = "The shell was cancelled, so I stopped."
const DELEGATED = "Waiting on my own subagent."
const NESTED_FINAL = "Final answer, written after my subagent finished."

/**
 * Plays every model in the family from its own transcript. A prompt containing `run-shell`
 * backgrounds `command`; one containing `delegate` backgrounds a subagent told to `run-shell`.
 * Each then ends its turn, and answers again once the notice it waits on arrives.
 */
const respond = (command: string) => (request: LLMRequest) => {
  const transcript = JSON.stringify(request.messages)
  if (transcript.includes(FINAL)) return TestLLM.text(NESTED_FINAL, "nested-final")
  if (transcript.includes("shell-42")) return TestLLM.text(FINAL, "final")
  if (transcript.includes('state=\\"cancelled\\"')) return TestLLM.text(CANCELLED, "cancelled")
  if (transcript.includes("is working in the background")) return TestLLM.text(DELEGATED, "delegated")
  if (transcript.includes("Command moved to the background")) return TestLLM.text(WAITING, "waiting")
  if (transcript.includes("run-shell")) return TestLLM.toolCall("call-shell", "shell", { command, background: true })
  if (transcript.includes("delegate"))
    return TestLLM.toolCall("call-grandchild", "subagent", {
      agent: "reviewer",
      description: "Grandchild",
      prompt: "run-shell",
      background: true,
    })
  return TestLLM.text("Unscripted request", "unscripted")
}

const SHELL = "sleep 1; echo shell-$((40+2))"

const family = (options: { depth?: number } = {}) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.promise(() =>
      Bun.write(
        `${dir.path}/opencode.json`,
        JSON.stringify({
          agents: { reviewer: { mode: "subagent" } },
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          ...(options.depth === undefined ? {} : { experimental: { subagent_depth: options.depth } }),
        }),
      ),
    )
    const sessions = yield* Session.Service
    const locations = yield* LocationServiceMap.Service
    const parent = yield* sessions.create({
      location: { directory: AbsolutePath.make(dir.path) },
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") }),
    })
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(parent.location)))
    const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
    const subagent = (id: string, input: { prompt: string; background?: boolean }) =>
      executeTool(registry, {
        sessionID: parent.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id,
          name: "subagent",
          input: { agent: "reviewer", description: "Child", ...input },
        },
      })
    return { parent, subagent }
  })

const childID = (metadata: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(metadata).sessionID

const text = (result: { content?: ReadonlyArray<{ type: string }> }) => JSON.stringify(result.content ?? [])

/** The parent's first subagent notice, once admitted. */
const notice = (parentID: Session.ID) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    return yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
      Stream.filter((event) => event.data.sessionID === parentID && event.data.item.type === "synthetic"),
      Stream.take(1),
      Stream.runCollect,
      Effect.map((events) => {
        const item = Array.from(events)[0]?.data.item
        return item?.type === "synthetic" ? item.payload : undefined
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  })

describe("subagent waiting on its own background work", () => {
  it.live(
    "a foreground subagent returns the answer it writes after its background shell finishes",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLM.Test
        yield* llm.serve(respond(SHELL))
        const { subagent } = yield* family()

        const result = yield* subagent("call-foreground", { prompt: "run-shell" })

        expect(result.status).toBe("completed")
        expect(text(result)).toContain(FINAL)
        expect(text(result)).not.toContain(WAITING)
        expect(result.metadata).toMatchObject({ status: "completed" })
        // Shell call, the turn that ends to wait, and the turn the shell's notice wakes.
        expect(yield* llm.requests()).toHaveLength(3)
      }),
    20_000,
  )

  it.live(
    "a background subagent notifies its parent once, with the answer it writes after its shell finishes",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLM.Test
        const jobs = yield* Job.Service
        yield* llm.serve(respond(SHELL))
        const { parent, subagent } = yield* family()
        const notified = yield* notice(parent.id)

        const result = yield* subagent("call-background", { prompt: "run-shell", background: true })
        const child = childID(result.metadata)
        // The child ends its turn to wait; the parent's job for it still reads running.
        yield* llm.wait(2)
        yield* Session.Service.use((sessions) => sessions.wait(child))
        expect((yield* jobs.get(child))?.status).toBe("running")

        const payload = yield* Fiber.join(notified)
        expect(payload?.text).toContain('state="completed"')
        expect(payload?.text).toContain(FINAL)
        expect(payload?.text).not.toContain(WAITING)
        const sessions = yield* Session.Service
        expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toHaveLength(1)
      }),
    20_000,
  )

  it.live(
    "a cancelled background shell still settles the parent with the child's answer to the cancellation",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLM.Test
        const jobs = yield* Job.Service
        const sessions = yield* Session.Service
        yield* llm.serve(respond("sleep 60"))
        const { parent, subagent } = yield* family()

        const running = yield* subagent("call-cancelled", { prompt: "run-shell" }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* llm.wait(2)
        // Cancel only once the child has ended its turn to wait.
        const child = (yield* sessions.list({ parentID: parent.id })).data[0]
        if (child === undefined) return yield* Effect.die("Expected a child session")
        yield* sessions.wait(child.id)
        const shell = yield* jobs.runningBackground.pipe(
          Effect.map((recoveries) => recoveries.find((recovery) => recovery.kind === "shell")),
          Effect.repeat({ until: (recovery) => recovery !== undefined }),
        )
        if (shell?.kind !== "shell") return yield* Effect.die("Expected a background shell")
        yield* jobs.cancel(shell.shellID)

        const result = yield* Fiber.join(running).pipe(Effect.timeout("10 seconds"))
        expect(result.status).toBe("completed")
        expect(text(result)).toContain(CANCELLED)
      }),
    20_000,
  )

  it.live(
    "deleting a waiting child settles its foreground parent instead of hanging",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLM.Test
        const sessions = yield* Session.Service
        yield* llm.serve(respond("sleep 60"))
        const { parent, subagent } = yield* family()

        const running = yield* subagent("call-deleted", { prompt: "run-shell" }).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* llm.wait(2)
        const child = (yield* sessions.list({ parentID: parent.id })).data[0]
        if (child === undefined) return yield* Effect.die("Expected a child session")
        yield* sessions.wait(child.id)
        yield* sessions.remove(child.id)

        const result = yield* Fiber.join(running).pipe(Effect.timeout("10 seconds"))
        expect(result.status).toBe("error")
        expect(JSON.stringify(result)).toContain("Subagent cancelled")
      }),
    20_000,
  )

  it.live(
    "a nested subagent waits on its own background subagent, which waits on its shell",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLM.Test
        yield* llm.serve(respond(SHELL))
        const { subagent } = yield* family({ depth: 2 })

        const result = yield* subagent("call-nested", { prompt: "delegate" })

        expect(result.status).toBe("completed")
        expect(text(result)).toContain(NESTED_FINAL)
        expect(text(result)).not.toContain(DELEGATED)
      }),
    30_000,
  )
})
