// Fork feature (shell-restart-wake), through the whole app: background shell commands across a restart that did not
// hand them over (a reboot, a crash, a service stop). The next server tells each owning session the command was
// cancelled, and wakes it, once, as the command's own end notice would have. A command that survived by handoff wakes
// its session at its real end; one the agent killed before the restart wakes nobody.
import { describe, expect } from "bun:test"
import path from "path"
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import type { ChildProcess } from "effect/process"
import { LanguageModel, LLMClient } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Plugin } from "@opencode/core/plugin"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Shell } from "@opencode/core/shell"
import { Environment } from "@opencode/core/environment/index"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { fakeDaemon } from "./fixture/persistent-pty-daemon"
import { recordingEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"

const it = testEffect(tempGlobalLayer)

const model = SessionRunnerModel.node.replace(
  Layer.succeed(SessionRunnerModel.Service, {
    select: (session) => Effect.fail(new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })),
    resolve: () =>
      Effect.succeed(
        SessionRunnerModel.resolved(LanguageModel.make({ id: "restart", provider: "test", route: OpenAIChat.route }), {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 32_000 },
        }),
      ),
  }),
)

// The pieces both servers share: the process daemon, the data directory, the database and the scripted model.
const world = Effect.gen(function* () {
  const daemon = yield* fakeDaemon()
  const root = (yield* tmpdirScoped()).path
  const data = path.join(root, "data")
  const global = Global.layerWith({
    data,
    cache: path.join(root, "cache"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    tmp: path.join(root, "tmp"),
    bin: path.join(root, "cache", "bin"),
    log: path.join(data, "log"),
    repos: path.join(data, "repos"),
  })
  const database = yield* Layer.build(Database.layer())
  const llm = yield* Layer.build(TestLLM.testLayer({ fallback: TestLLM.text("Done", "done") }))
  const project = (yield* tmpdirScoped()).path
  const spawns: ChildProcess.Command[] = []
  const server = (scope: Scope.Scope) =>
    Layer.buildWithScope(
      AppNodeBuilder.build(
        LayerNode.group([
          PersistentPty.node,
          Shell.daemonNode,
          Session.node,
          LocationServiceMap.node,
          SessionRestart.node,
        ]),
        [
          Global.node.replace(global),
          Database.node.replace(Layer.succeedContext(database)),
          LayerNodePlatform.llmClient.replace(Layer.succeedContext(Context.pick(LLMClient.Service)(llm))),
          PersistentPty.node.replace(PersistentPty.configured(daemon.options)),
          Environment.node.replace(recordingEnvironmentLayer(spawns)),
          Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
          Watcher.node.replace(Watcher.configured({ enabled: false })),
          offlineModels,
          model,
        ],
      ),
      scope,
    )
  const open = (one: Effect.Success<ReturnType<typeof server>>) =>
    Effect.gen(function* () {
      const session = yield* Context.get(one, Session.Service).create({
        location: { directory: AbsolutePath.make(project) },
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ id: Model.ID.make("restart"), providerID: Provider.ID.make("test") }),
      })
      yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(
        Effect.provide(Context.get(one, LocationServiceMap.Service).get(session.location)),
      )
      return session
    })
  return { daemon, llm: Context.get(llm, TestLLM.Test), server, open }
})

// The last message of a model request, as text.
const last = (request: { readonly messages: ReadonlyArray<unknown> }) => JSON.stringify(request.messages.at(-1) ?? "")
const job = (text: string) => /run (job-\d+)/.exec(text)?.[1]

const until = (check: () => boolean, timeout = 20_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeout
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out"))
      yield* Effect.sleep(5)
    }
  })

// A session starts one background command per `run job-N` prompt; the next server's model answers each notice
// request after `hold` ms, counting how many are in flight at once.
const script =
  (state: { inFlight: number; peak: number; notices: string[]; started: number[] }, hold: number) =>
  (request: { readonly tools: ReadonlyArray<{ name: string }>; readonly messages: ReadonlyArray<unknown> }) => {
    const text = last(request)
    const tag = job(text)
    if (tag && request.tools.some((tool) => tool.name === "shell"))
      return TestLLM.toolCall(`call-${tag}`, "shell", { command: `sleep 600 # ${tag}`, background: true })
    if (!text.includes("background-result")) return TestLLM.text("Started", "started")
    state.notices.push(text)
    return Stream.unwrap(
      Effect.gen(function* () {
        state.started.push(Date.now())
        state.inFlight++
        state.peak = Math.max(state.peak, state.inFlight)
        yield* Effect.sleep(hold)
        return Stream.fromIterable(TestLLM.text("Noted", "noted"))
      }),
    ).pipe(Stream.ensuring(Effect.sync(() => void state.inFlight--)))
  }

describe("RestartWake through the whole app", () => {
  it.live("wakes 20 sessions whose background commands a reboot killed, each once, through the usual doorbell", () =>
    Effect.gen(function* () {
      const { daemon, llm, server, open } = yield* world
      const state = { inFlight: 0, peak: 0, notices: [] as string[], started: [] as number[] }
      yield* llm.serve(script(state, 200))

      const first = yield* Scope.make()
      const one = yield* server(first)
      const sessions = Context.get(one, Session.Service)
      const owners = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        () => open(one),
      )
      yield* Effect.forEach(owners, (session, index) =>
        sessions.prompt({ sessionID: session.id, text: `run job-${index}` }),
      )
      yield* until(() => daemon.processes.length === 20)
      yield* Effect.forEach(owners, (session) => sessions.wait(session.id), { discard: true })

      // No handoff: the shutdown stops the commands, and a reboot's fresh daemon knows none of them.
      yield* Scope.close(first, Exit.void)
      expect(daemon.processes.every((command) => command.lifecycle.status === "exited")).toBe(true)
      daemon.processes.splice(0)
      expect(state.notices).toEqual([])

      const second = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(second, Exit.void))
      const two = yield* server(second)
      const restarted = Context.get(two, Session.Service)
      const sweep = Date.now()
      yield* Context.get(two, SessionRestart.Service).resumeSuspendedSessions
      yield* until(() => state.notices.length >= 20)
      yield* Effect.forEach(owners, (session) => restarted.wait(session.id), { discard: true })
      const lastWake = Math.max(...state.started) - sweep
      console.log(
        `restart-wake measurement: woken ${state.notices.length}/20, peak concurrent turns ${state.peak}, time to last wake ${lastWake} ms`,
      )

      // Each session got its own cancelled notice in one woken turn, once.
      expect(state.notices).toHaveLength(20)
      for (const [index, session] of owners.entries()) {
        const notices = (yield* restarted.context(session.id)).filter(
          (message) => message.type === "synthetic" && message.metadata?.source === "shell",
        )
        expect(notices).toHaveLength(1)
        const notice = notices[0]
        if (notice?.type !== "synthetic") return yield* Effect.die("no notice")
        expect(notice.metadata).toMatchObject({ state: "cancelled" })
        expect(notice.text).toContain(`job-${index}">`)
        expect(notice.text).toContain("Command cancelled because the server restarted")
        expect(notice.text).toContain("Nothing was rerun")
      }
      // A second restart wakes nobody.
      yield* Scope.close(second, Exit.void)
      const third = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(third, Exit.void))
      const three = yield* server(third)
      yield* Context.get(three, SessionRestart.Service).resumeSuspendedSessions
      yield* Effect.sleep(300)
      expect(state.notices).toHaveLength(20)
    }),
  )

  it.live("wakes nobody for a background command the agent killed before the restart", () =>
    Effect.gen(function* () {
      const { daemon, llm, server, open } = yield* world
      const state = { inFlight: 0, peak: 0, notices: [] as string[], started: [] as number[] }
      const answer = script(state, 0)
      let requests = 0
      yield* llm.serve((request) => {
        requests++
        const text = last(request)
        // The call's result names the shell: kill it by its handle.
        const id = /moved to the background|"backgrounded"/.test(text) ? undefined : /(sh_\w+)/.exec(text)?.[1]
        if (id && !text.includes("background-result") && !text.includes('"killed"') && !text.includes("· killed"))
          return TestLLM.toolCall("call-kill", "shell", { action: "kill", id })
        return answer(request)
      })

      const first = yield* Scope.make()
      const one = yield* server(first)
      const sessions = Context.get(one, Session.Service)
      const session = yield* open(one)
      yield* sessions.prompt({ sessionID: session.id, text: "run job-0" })
      yield* until(() => daemon.processes.length === 1)
      yield* until(() => daemon.processes[0]?.lifecycle.status === "exited")
      yield* sessions.wait(session.id)
      yield* Scope.close(first, Exit.void)
      daemon.processes.splice(0)
      const before = requests

      const second = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(second, Exit.void))
      const two = yield* server(second)
      yield* Context.get(two, SessionRestart.Service).resumeSuspendedSessions
      yield* Effect.sleep(300)
      yield* Context.get(two, Session.Service).wait(session.id)
      expect(requests).toBe(before)
      expect(state.notices).toEqual([])
    }),
  )

  it.live("leaves a command that survived by handoff to wake its session at its real end", () =>
    Effect.gen(function* () {
      const { daemon, llm, server, open } = yield* world
      const state = { inFlight: 0, peak: 0, notices: [] as string[], started: [] as number[] }
      yield* llm.serve(script(state, 0))

      const first = yield* Scope.make()
      const one = yield* server(first)
      const sessions = Context.get(one, Session.Service)
      const session = yield* open(one)
      yield* sessions.prompt({ sessionID: session.id, text: "run job-0" })
      yield* until(() => daemon.processes.length === 1)
      yield* sessions.wait(session.id)
      expect(yield* Context.get(one, PersistentPty.Service).handoff()).not.toBeNull()
      yield* Scope.close(first, Exit.void)
      const command = daemon.processes[0]!
      expect(command.lifecycle.status).toBe("running")

      const second = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(second, Exit.void))
      const two = yield* server(second)
      yield* Context.get(two, SessionRestart.Service).resumeSuspendedSessions
      yield* Effect.sleep(300)
      expect(state.notices).toEqual([])
      daemon.exit(command.id, 0)
      yield* until(() => state.notices.length === 1)
      expect(state.notices[0]).toContain('state=\\"completed\\"')
      yield* Context.get(two, Session.Service).wait(session.id)
      expect(state.notices).toHaveLength(1)
    }),
  )
})
