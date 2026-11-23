// Fork feature (synthetic-archived): a project whose commands select an agent or a model, on the real location, config
// command plugin, plan plugin and runner with a scripted model (the harness of goal-archived.test.ts). Only upstream
// modules are imported, so the order test runs unchanged at the base.
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { LanguageModel } from "@opencode/ai/effect"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./global"
import { offlineModels } from "./models"
import { tmpdirScoped } from "./tmpdir"
import { database } from "./test-database"

const llm = TestLLM.testLayer({ fallback: TestLLM.text("Done", "work") })

export const commandLayer = (replacements: LayerNode.Replacements = [], file?: string) =>
  Layer.merge(
    llm,
    AppNodeBuilder.build(
      LayerNode.group([Database.node, Bus.node, Session.node, LocationServiceMap.node, Job.node, KV.node]),
      [
        database(file),
        Global.node.replace(tempGlobalLayer),
        offlineModels,
        Watcher.node.replace(Watcher.configured({ enabled: false })),
        LayerNodePlatform.llmClient.replace(llm),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, {
            select: (session) => Effect.fail(new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })),
            resolve: () =>
              Effect.succeed(
                SessionRunnerModel.resolved(
                  LanguageModel.make({ id: "m", provider: "test", route: OpenAIChat.route }),
                  {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: [],
                    limit: { context: 200_000, output: 32_000 },
                  },
                ),
              ),
          }),
        ),
        ...replacements,
      ],
    ),
  )

/**
 * A local Promise plugin: `select` (plan and m2, no prompt), `read` (plan, then reads the session back into
 * `globalThis.__selectionRead`), and a prompt hook that awaits `globalThis.__onPrompt` when a test sets it.
 */
const plugin = `export default {
  id: "test.selection",
  async setup(ctx) {
    await ctx.session.hook("prompt", async () => {
      if (globalThis.__onPrompt) await globalThis.__onPrompt()
    })
    await ctx.command.transform((editor) => {
      editor.add({
        name: "select",
        execute: async (input) => {
          await ctx.session.switchAgent({ sessionID: input.sessionID, agent: "plan" })
          await ctx.session.switchModel({ sessionID: input.sessionID, model: { providerID: "test", id: "m2" } })
        },
      })
      editor.add({
        name: "read",
        execute: async (input) => {
          await ctx.session.switchAgent({ sessionID: input.sessionID, agent: "plan" })
          const seen = await ctx.session.get({ sessionID: input.sessionID })
          globalThis.__selectionRead = { ...globalThis.__selectionRead, [input.sessionID]: JSON.stringify(seen) }
        },
      })
    })
  },
}
`

/** A session in a project with the commands `/pick` (to plan, m2), `/leave` (to build), `/m2` (model only). */
export function project(agent = "build") {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* Effect.promise(() => writeProject(tmp.path))
    return yield* create(tmp.path, agent)
  })
}

/** Writes the project's commands and local plugin into `directory`. */
export async function writeProject(directory: string) {
  const commands = path.join(directory, ".opencode", "commands")
  await mkdir(commands, { recursive: true })
  await mkdir(path.join(directory, ".opencode", "plugins"), { recursive: true })
  await writeFile(path.join(commands, "pick.md"), "---\nagent: plan\nmodel: test/m2\n---\nPick $ARGUMENTS")
  await writeFile(path.join(commands, "leave.md"), "---\nagent: build\n---\nLeave $ARGUMENTS")
  await writeFile(path.join(commands, "m2.md"), "---\nmodel: test/m2\n---\nModel $ARGUMENTS")
  await writeFile(path.join(directory, ".opencode", "plugins", "selection.js"), plugin)
}

/** A session in `directory` (a project written by `writeProject`). */
export function create(directory: string, agent = "build") {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    return yield* sessions.create({
      location: { directory: AbsolutePath.make(directory) },
      title: "Command session",
      agent: Agent.ID.make(agent),
      model: Model.Ref.make({ id: Model.ID.make("m"), providerID: Provider.ID.make("test") }),
    })
  })
}

/** Runs `/name` through Session.command (`run` wraps it, as the server's route does), waits, answers the new messages' types. */
export const sequence = (
  sessionID: Session.ID,
  name: string,
  run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = (effect) => effect,
) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const before = (yield* sessions.messages({ sessionID, order: "asc" })).length
    yield* run(sessions.command({ sessionID, command: name, text: "now" }))
    yield* sessions.wait(sessionID)
    // A reaction to a selection with no prompt is asynchronous upstream: give it its turn.
    yield* Effect.sleep(50)
    return (yield* sessions.messages({ sessionID, order: "asc" })).slice(before).map((message) => message.type)
  })
