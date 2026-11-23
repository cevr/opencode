// Fork feature (synthetic-archived): /goal in an archived session. The user's own /goal is the user's prompt, so its
// kickoff is admitted and runs; the loop's later continuation is the goal plugin's, refused by the archived session.
// The plugin is told, pauses the goal once, and does not retry in a loop. The harness is goal.test.ts's.
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { LanguageModel, type LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { GoalPlugin } from "@opencode/core/plugin/goal"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionAdmission } from "@opencode/core/session/admission"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Goal } from "@opencode/schema/goal"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { database } from "../fixture/test-database"
import { testEffect } from "../lib/effect"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("Working on it", "work") })
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(LayerNode.group([Session.node, LocationServiceMap.node, Job.node, KV.node]), [
      database(),
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      LayerNodePlatform.llmClient.replace(llmLayer),
      SessionRunnerModel.node.replace(
        Layer.succeed(SessionRunnerModel.Service, {
          select: (session) => Effect.fail(new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })),
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: "goal", provider: "test", route: OpenAIChat.route }),
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

const model = Model.Ref.make({ id: Model.ID.make("goal"), providerID: Provider.ID.make("test") })

describe("goal plugin in an archived session", () => {
  it.live("the user's /goal starts; its continuation is refused, the goal pauses once, no loop", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const verdicts = reviewer(
        '{"verdict":"continue","reason":"The parser test still fails.","next_step":"Fix the date parser."}',
        '{"verdict":"continue","reason":"Still failing.","next_step":"Try again."}',
        '{"verdict":"continue","reason":"Still failing.","next_step":"Try again."}',
      )
      yield* serve(verdicts.respond)
      yield* sessions.archive(session.id)

      // The server's `session.command` route: the user typed /goal in the archived session.
      yield* SessionAdmission.userCommand(session.id)(
        sessions.command({ sessionID: session.id, command: "goal", text: "Make the test suite pass" }),
      )
      yield* sessions.wait(session.id)
      // Unarchiving starts nothing: the goal is paused and nothing is pending.
      yield* sessions.unarchive(session.id)
      yield* Effect.sleep(50)
      yield* sessions.wait(session.id)

      // One review, one refused continuation, then the goal pauses: the plugin was told and stopped.
      expect(verdicts.asked()).toBe(1)
      expect(yield* goal(session.id)).toMatchObject({ status: "paused", reason: "The goal stopped after an error" })
      const messages = yield* sessions.messages({ sessionID: session.id, order: "asc" })
      expect(messages.filter((message) => message.type === "synthetic")).toMatchObject([
        { description: "Goal: Make the test suite pass" },
      ])
      expect(messages.filter((message) => message.type === "idle")).toHaveLength(1)
    }),
  )

  it.live("a /goal a non-user caller runs in an archived session is refused before it starts", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const verdicts = reviewer()
      yield* serve(verdicts.respond)
      yield* sessions.archive(session.id)

      // No user mark (an automation, a plugin's ctx.session.command): the kickoff is the plugin's, refused.
      const exit = yield* sessions
        .command({ sessionID: session.id, command: "goal", text: "Make the test suite pass" })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      yield* sessions.wait(session.id)
      expect(verdicts.asked()).toBe(0)
      const messages = yield* sessions.messages({ sessionID: session.id, order: "asc" })
      expect(messages.filter((message) => message.type === "synthetic")).toEqual([])
    }),
  )
})

const REVIEW_MARKER = "You are now the reviewer for the session's goal"

// Answers reviewer requests from a script and every other request as ordinary assistant work.
function reviewer(...replies: ReadonlyArray<string>) {
  const queue = [...replies]
  const asked = { count: 0 }
  return {
    asked: () => asked.count,
    respond: (request: LLMRequest) => {
      if (!isReview(request)) return TestLLM.text("Working on it", "work")
      asked.count++
      return TestLLM.text(queue.shift() ?? '{"verdict":"done","reason":"Out of script."}', `review-${asked.count}`)
    },
  }
}

function isReview(request: LLMRequest) {
  return JSON.stringify(request.messages.at(-1)).includes(REVIEW_MARKER)
}

function serve(respond: (request: LLMRequest) => TestLLM.Response) {
  return TestLLM.Test.use((llm) => llm.serve(respond))
}

// The goal plugin's own storage, as the plugin host hands it to the plugin.
const goals = KV.Service.use((kv) => Effect.succeed(PluginHost.storage(kv, GoalPlugin.Plugin.id)))
const decodeGoal = Schema.decodeUnknownOption(Goal.State)

function goal(sessionID: Session.ID) {
  return goals.pipe(
    Effect.flatMap((storage) => storage.get(`session:${sessionID}`)),
    Effect.map((value) => Option.getOrUndefined(decodeGoal(value))),
  )
}

function project() {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const sessions = yield* Session.Service
    return yield* sessions.create({
      location: { directory: AbsolutePath.make(tmp.path) },
      title: "Goal session",
      agent: Agent.ID.make("build"),
      model,
    })
  })
}
