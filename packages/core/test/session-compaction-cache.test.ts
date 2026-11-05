import { expect } from "bun:test"
import { LLMClient, LLMEvent, LanguageModel, ToolDefinition, type LLMRequest } from "@opencode/ai/effect"
import { AnthropicMessages } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/testing"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Instructions } from "@opencode/core/instructions/index"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Session } from "@opencode/core/session"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Agent } from "@opencode/core/agent"
import { AbsolutePath } from "@opencode/core/schema"
import { Money } from "@opencode/schema/money"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

let requests: LLMRequest[] = []
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "summary", text: "## Objective\n- summary" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: { normalized: "stop" },
        usage: { inputTokens: 1, outputTokens: 1, nonCachedInputTokens: 1 },
      }),
      LLMEvent.finish({ reason: { normalized: "stop" } }),
    )
  },
  generate: () => Effect.die("unused"),
})

const model = {
  ...SessionRunnerModel.resolved(
    LanguageModel.make({ id: "claude-opus-5-5", provider: "anthropic", route: AnthropicMessages.route }),
    {
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      cost: [
        {
          input: Money.USDPerMillionTokens.make(1),
          output: Money.USDPerMillionTokens.make(2),
          cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
        },
      ],
      limit: { context: 200_000, output: 32_000 },
    },
  ),
  cache: { ttl: "1h" as const },
}

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(client),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const insertSession = (id: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        time_created: 0,
        time_updated: 0,
      })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    return yield* store
      .get(id)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die(`session missing: ${id}`))))
  })

const user = (text: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    time: { created: DateTime.makeUnsafe(0) },
  })

let call = 0
/** One agent step: signed thinking, a little text, and a tool call whose output is `output` characters. */
const step = (output: number, final = false) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "claude-opus-5-5", providerID: "anthropic" },
    content: [
      {
        type: "reasoning",
        text: `thinking ${call}`,
        native: { signature: `sig_${call}` },
        time: { created: 0, completed: 0 },
      },
      { type: "text", text: `Working on step ${call}` },
      ...(final
        ? []
        : [
            {
              type: "tool",
              id: `toolu_${++call}`,
              name: "read",
              state: {
                status: "completed",
                input: { path: `f${call}` },
                content: [{ type: "text", text: "y".repeat(output) }],
              },
              time: { created: 0 },
            },
          ]),
    ],
    time: { created: 0, completed: 0 },
  })

type Block = { readonly role: string; readonly block: Record<string, unknown> }
const blocksOf = (body: Record<string, unknown>): Block[] =>
  (body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).flatMap((message) =>
    message.content.map((block) => ({ role: message.role, block })),
  )
const withoutCache = (block: Block) => {
  const { cache_control: _, ...rest } = block.block
  return JSON.stringify([block.role, rest])
}
const breakpoints = (blocks: Block[]) => blocks.flatMap((b, i) => (b.block.cache_control ? [i] : []))
const sharedBlocks = (a: Block[], b: Block[]) => {
  const n = Math.min(a.length, b.length)
  const index = Array.from({ length: n }, (_, i) => i).find((i) => withoutCache(a[i]!) !== withoutCache(b[i]!))
  return index ?? n
}

it.effect("summary guidance from the compaction hook keeps the conversation's cached prefix", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_compaction_cache"))
    const tools = {
      definitions: [ToolDefinition.make({ name: "read", description: "Read files", inputSchema: { type: "object" } })],
      execute: () => Effect.die("unused"),
    }
    const context = (messages: readonly SessionMessage.Info[]) => ({
      session,
      messages,
      model,
      agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
      initial: [{ key: Instructions.Key.make("test/session"), text: "Session instructions" }],
      tools,
    })
    // A long first exchange and a shorter second one that fits the kept tail, so the summary is sent the history
    // before that tail, as most automatic compactions are.
    const messages: SessionMessage.Info[] = [user("First task")]
    for (let i = 0; i < 8; i++) messages.push(step(80_000))
    messages.push(step(0, true))
    messages.push(user("Second task"))
    for (let i = 0; i < 8; i++) messages.push(step(15_000))

    const guidance = "Keep the files, the step and the user's instructions word for word."
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        event.experimental.prompt.push(guidance)
      }),
    )

    // Each request the runner sent before an assistant step, as Anthropic received it.
    const builder = yield* SessionModelRequest.Service
    const primaries = yield* Effect.forEach(
      messages.flatMap((message, index) => (message.type === "assistant" ? [index] : [])).concat([messages.length]),
      (end) =>
        Effect.gen(function* () {
          const loaded = context(messages.slice(0, end))
          const transcript = SessionModelRequest.baseTranscript({ ...loaded, agent: loaded.agent.info })
          const prepared = yield* builder.primary({
            session,
            agent: loaded.agent.id,
            model,
            tools,
            system: transcript.system,
            messages: transcript.messages,
          })
          return (yield* compileRequest(prepared.request)).body as Record<string, unknown>
        }),
    )

    const compaction = yield* SessionCompaction.Service
    expect(yield* compaction.compact({ reason: "auto", context: context(messages) })).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    const summary = (yield* compileRequest(requests[0]!)).body as Record<string, unknown>
    const last = primaries.at(-1)!

    // Tools and system, breakpoints included, are what the conversation sent.
    expect(summary.tools).toEqual(last.tools)
    expect(summary.system).toEqual(last.system)
    // Every message block matches the conversation's up to the summary prompt, which carries the hook's guidance.
    const blocks = blocksOf(summary)
    expect(sharedBlocks(blocks, blocksOf(last))).toBe(blocks.length - 1)
    expect(blocks.at(-1)!.block.text).toContain(guidance)
    // Anthropic reads a cached prefix that ends within 20 blocks before a breakpoint. One of the conversation's
    // writes lies in that range of the summary's breakpoint and inside the shared prefix.
    const read = breakpoints(blocks).at(-1)!
    const written = primaries
      .map(blocksOf)
      .flatMap((primary) => breakpoints(primary).filter((at) => at < sharedBlocks(blocks, primary)))
    expect(written.some((at) => at <= read && read - at < 20)).toBe(true)
  }),
)
