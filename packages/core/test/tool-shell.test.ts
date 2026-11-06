import fs from "fs/promises"
import { realpathSync, watch } from "node:fs"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Plugin } from "@opencode/core/plugin"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Shell } from "@opencode/core/shell"
import { ShellSelect } from "@opencode/core/shell/select"
import { ID, type Info as ShellInfo } from "@opencode/schema/shell"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { ToolOutput } from "@opencode/core/tool-output"
import { Tool } from "@opencode/core/tool"
import { definition } from "@opencode/core/tool/runtime"
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { Expected } from "./lib/session-message"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const sessionID = Session.ID.make("ses_shell_tool_test")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })
const assertions: Permission.AssertInput[] = []
let denyAction: string | undefined
let afterPermission = (_input: Permission.AssertInput): Effect.Effect<void> => Effect.void

const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => assertions.push(input)).pipe(
      Effect.andThen(Effect.suspend(() => afterPermission(input))),
      Effect.andThen(
        input.action === denyAction
          ? Effect.fail(
              new Permission.BlockedError({
                rules: [],
                permission: input.action,
                resources: input.resources,
              }),
            )
          : Effect.void,
      ),
    ),
})

const reset = () => {
  assertions.length = 0
  denyAction = undefined
  afterPermission = () => Effect.void
}

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const complete = Effect.fn("ShellTest.complete")(function* (id: Session.ID) {
        const session = yield* store.get(id)
        if (!session) return
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID: id,
          assistantMessageID,
          agent: session.agent ?? Agent.ID.make("code"),
          model: sessionModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, {
          sessionID: id,
          assistantMessageID,
          ordinal: 0,
        })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID: id,
          assistantMessageID,
          ordinal: 0,
          text: "ok",
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID: id,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (id) => complete(id).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const shellPluginSupervisor = makeLocationNode({
  name: "test/shell-plugins",
  layer: Layer.effectDiscard(registerToolPlugin(ShellTool.Plugin)),
  deps: [
    Config.node,
    Environment.node,
    FileAccess.node,
    Permission.node,
    Session.node,
    Job.node,
    Shell.node,
    ShellSelect.node,
    Tool.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
  filesystem,
  FSUtil.node,
  Global.node,
])
const replacements = [
  SessionExecution.node.replace(executionNode),
  Permission.node.replace(permission),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
const it = testEffect(
  AppNodeBuilder.build(nodes, [...replacements, PluginSupervisor.node.replace(shellPluginSupervisor)]),
)
const permissionIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([nodes, PermissionSaved.node]), [
    SessionExecution.node.replace(executionNode),
    Global.node.replace(tempGlobalLayer),
    PluginSupervisor.node.replace(shellPluginSupervisor),
    offlineModels,
  ]),
)

const call = (input: typeof ShellTool.Input.Type, id = "call-shell") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "shell", input },
})

const textOf = (result: { content?: ReadonlyArray<{ type: string; text?: string }> }) =>
  (result.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n")

// A command call's content: its handle's header line (`sh_… · exited 0 · 0.1 s`), then its output.
const handleContent = (output: string, state = "exited 0") => [
  { type: "text" as const, text: expect.stringMatching(new RegExp(`^sh_\\w+ · ${state} · \\d`)) },
  { type: "text" as const, text: output },
]

const isWindows = process.platform === "win32"
const cwdCommand = isWindows ? "(Get-Location).Path; Start-Sleep -Milliseconds 100" : "pwd"
const helloCommand = isWindows ? "[Console]::Out.Write('hello'); Start-Sleep -Milliseconds 100" : "printf hello"
const stderrCommand = isWindows
  ? "[Console]::Error.Write('stderr only'); Start-Sleep -Milliseconds 100"
  : "printf 'stderr only' >&2"
const mixedOutputCommand = isWindows
  ? "[Console]::Out.Write('stdout'); Start-Sleep -Milliseconds 50; [Console]::Error.Write('stderr'); Start-Sleep -Milliseconds 100"
  : "printf stdout; sleep 0.05; printf stderr >&2"
const idleCommand = isWindows ? "Start-Sleep -Seconds 60" : "sleep 60"
const bodyExitCommand = isWindows
  ? "[Console]::Out.Write('body'); Start-Sleep -Milliseconds 100; exit 7"
  : "printf body && exit 7"
const overflowCommand = (bytes: number) =>
  isWindows
    ? `[Console]::Out.Write('output-start' + ('x' * ${bytes}) + 'output-end'); Start-Sleep -Milliseconds 100`
    : `printf output-start; head -c ${bytes} /dev/zero | tr '\\0' 'x'; printf output-end`
const lineOverflowCommand = isWindows
  ? "[Console]::Out.Write('one' + [Environment]::NewLine + 'two' + [Environment]::NewLine + 'three')"
  : "printf 'one\\ntwo\\nthree'"
const progressOverflowCommand = (bytes: number, release: string) =>
  isWindows
    ? `[Console]::Out.Write(('x' * ${bytes})); while (!(Test-Path -LiteralPath '${release}')) { Start-Sleep -Milliseconds 50 }`
    : `head -c ${bytes} /dev/zero | tr '\\0' 'x'; while [ ! -e '${release}' ]; do sleep 0.05; done`

const withSession = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({
      id: sessionID,
      title: "shell test",
      location,
      model: sessionModel,
    })
    const locations = yield* LocationServiceMap.Service
    const locationLayer = locations.get(location)
    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const registry = yield* Tool.Service
      return yield* body(registry)
    }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))
  })

const withScanner = <A, E, R>(
  body: (registry: Tool.Interface, fixture: { active: string; outside: string }) => Effect.Effect<A, E, R>,
  shell = "sh",
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const fixture = { active: path.join(tmp.path, "active"), outside: path.join(tmp.path, "outside") }
        yield* Effect.promise(() => Promise.all([fs.mkdir(fixture.active), fs.mkdir(fixture.outside)]))
        return yield* withSession(fixture.active, (registry) =>
          Effect.gen(function* () {
            const selection = yield* ShellSelect.Service
            yield* selection.transform((editor) => editor.configure(shell))
            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = []
              }),
            )
            return yield* body(registry, fixture)
          }),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
  )

// The timeout catches a hung permission flow, not slowness: PowerShell commands on loaded Windows runners have exceeded 5s.
const runPermissionCommand = (
  registry: Tool.Interface,
  command: string,
  marker: string,
  replies: ReadonlyArray<Permission.Reply>,
) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const bus = yield* Bus.Service
    const queue = yield* Queue.unbounded<Permission.Request>()
    yield* bus.subscribe(Permission.Event.Asked).pipe(
      Stream.runForEach((event) => Queue.offer(queue, event.data)),
      Effect.forkScoped({ startImmediately: true }),
    )
    const execution = yield* executeTool(registry, call({ command }, `call-${Permission.ID.create()}`)).pipe(
      Effect.forkScoped,
    )
    const requests = yield* Effect.forEach(replies, (reply) =>
      Effect.gen(function* () {
        const request = yield* Queue.take(queue)
        expect(yield* permission.forSession(sessionID)).toEqual([request])
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        yield* permission.reply({ requestID: request.id, reply })
        return request
      }),
    )
    const exit = yield* Fiber.await(execution)
    expect(yield* permission.list()).toEqual([])
    expect(yield* Queue.size(queue)).toBe(0)
    return { exit, requests }
  }).pipe(Effect.scoped, Effect.timeout(Duration.seconds(15)))

describe("ShellTool scanner permissions", () => {
  const test = isWindows || !Bun.which("sh") ? permissionIt.live.skip : permissionIt.live

  test("declarations reuse approvals while substitutions retain reject/once/always behavior", () =>
    withScanner((registry, fixture) =>
      Effect.gen(function* () {
        const saved = yield* PermissionSaved.Service
        const location = yield* Location.Service
        yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["printf *"] })
        const marker = path.join(fixture.active, "marker")
        const approved = yield* runPermissionCommand(
          registry,
          "export SCAN_TEST=hello; unset SCAN_TEST; printf hello > marker",
          marker,
          [],
        )
        expect(approved.requests).toEqual([])
        expect(approved.exit).toMatchObject({
          _tag: "Success",
          value: { status: "completed", metadata: { exit: 0 } },
        })
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
        expect((yield* saved.list()).map((item) => item.resource)).toEqual(["printf *"])

        yield* Effect.forEach(yield* saved.list(), (item) => saved.remove(item.id))
        const command = 'export SCAN_TEST=$(printf hello); printf %s "$SCAN_TEST" > marker'
        const prompts: Permission.Request[] = []
        for (const reply of ["reject", "once", "always", undefined] as const) {
          yield* Effect.promise(() => fs.rm(marker, { force: true }))
          const result = yield* runPermissionCommand(registry, command, marker, reply ? [reply] : [])
          prompts.push(...result.requests)
          if (reply === "reject") {
            expect(Exit.isFailure(result.exit)).toBe(true)
            if (Exit.isFailure(result.exit))
              expect(
                result.exit.cause.reasons.some(
                  (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
                ),
              ).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
            continue
          }
          expect(result.exit).toMatchObject({
            _tag: "Success",
            value: { status: "completed", metadata: { exit: 0 } },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")
          if (reply === "once") expect(yield* saved.list()).toEqual([])
        }
        expect(prompts).toHaveLength(3)
        for (const request of prompts) {
          expect(request).toMatchObject({
            action: "shell",
            resources: ["printf hello", 'printf %s "$SCAN_TEST" > marker'],
            save: ["printf *", "printf *"],
          })
        }
        expect((yield* saved.list()).map((item) => item.resource)).toEqual(["printf *"])

        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(toolIdentity.agent, (agent) => {
            agent.permissions = [{ action: "shell", resource: "printf hello", effect: "deny" }]
          }),
        )
        yield* Effect.promise(() => fs.rm(marker))
        const denied = yield* runPermissionCommand(registry, command, marker, [])
        expect(denied.exit).toMatchObject({
          _tag: "Success",
          value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
        })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    ))

  test("pipeline redirect keeps the redirect target visible to exact approval and denial", () =>
    withScanner((registry, fixture) =>
      Effect.gen(function* () {
        const saved = yield* PermissionSaved.Service
        const location = yield* Location.Service
        yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["printf hello", "cat"] })
        const marker = path.join(fixture.active, "marker")
        const command = "printf hello | cat > marker"
        const unapprovedRedirect = yield* runPermissionCommand(registry, command, marker, ["reject"])
        expect(unapprovedRedirect.requests).toMatchObject([
          { action: "shell", resources: ["printf hello", "cat > marker"], save: ["printf *", "cat *"] },
        ])
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)

        yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["cat > marker"] })
        const exact = yield* runPermissionCommand(registry, command, marker, [])
        expect(exact.requests).toEqual([])
        expect(exact.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")

        yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["printf *", "cat *"] })
        yield* Effect.promise(() => fs.rm(marker))
        const broad = yield* runPermissionCommand(registry, command, marker, [])
        expect(broad.requests).toEqual([])
        expect(broad.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("hello")

        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(toolIdentity.agent, (agent) => {
            agent.permissions = [{ action: "shell", resource: "* > marker", effect: "deny" }]
          }),
        )
        yield* Effect.promise(() => fs.rm(marker))
        const denied = yield* runPermissionCommand(registry, command, marker, [])
        expect(denied.requests).toEqual([])
        expect(denied.exit).toMatchObject({
          _tag: "Success",
          value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
        })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    ))

  test("external-directory rejection stops execution before a workspace marker is written", () =>
    withScanner((registry, fixture) =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(toolIdentity.agent, (agent) => {
            agent.permissions = [{ action: "shell", resource: "*", effect: "allow" }]
          }),
        )
        const marker = path.join(fixture.active, "marker")
        const command = `cd '${fixture.outside}' && pwd -P && printf reached > '${marker}'`
        for (const reply of ["reject", "once"] as const) {
          const result = yield* runPermissionCommand(registry, command, marker, [reply])
          expect(result.requests).toMatchObject([
            { action: "external_directory", resources: [path.join(fixture.outside, "*")] },
          ])
          if (reply === "reject") {
            expect(Exit.isFailure(result.exit)).toBe(true)
            if (Exit.isFailure(result.exit))
              expect(
                result.exit.cause.reasons.some(
                  (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
                ),
              ).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
            continue
          }
          expect(result.exit).toMatchObject({
            _tag: "Success",
            value: {
              status: "completed",
              metadata: { exit: 0 },
              content: handleContent(`${fixture.outside}\n`),
            },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
        }
      }),
    ))

  test("a numeric symlink operand still reaches outside without an external-directory prompt", () =>
    withScanner((registry, fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.symlink(fixture.outside, path.join(fixture.active, "123")))
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(toolIdentity.agent, (agent) => {
            agent.permissions = [
              { action: "shell", resource: "*", effect: "allow" },
              { action: "external_directory", resource: "*", effect: "deny" },
            ]
          }),
        )
        const marker = path.join(fixture.active, "marker")
        const result = yield* runPermissionCommand(
          registry,
          `cd 123 && pwd -P && printf reached > '${marker}'`,
          marker,
          [],
        )
        expect(result.requests).toEqual([])
        expect(result.exit).toMatchObject({
          _tag: "Success",
          value: {
            status: "completed",
            metadata: { exit: 0 },
            content: handleContent(`${fixture.outside}\n`),
          },
        })
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
      }),
    ))

  test("a continued directory operand resolves to the destination and enforces external-directory deny", () =>
    withScanner((registry, fixture) =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(toolIdentity.agent, (agent) => {
            agent.permissions = [
              { action: "shell", resource: "*", effect: "allow" },
              { action: "external_directory", resource: path.join(fixture.outside, "*"), effect: "deny" },
            ]
          }),
        )
        const marker = path.join(fixture.active, "marker")
        const command = `cd ../out\\\nside && pwd -P && printf reached > '${marker}'`
        const denied = yield* runPermissionCommand(registry, command, marker, [])
        expect(denied.requests).toEqual([])
        expect(denied.exit).toMatchObject({
          _tag: "Success",
          value: { status: "error", error: { message: expect.stringContaining("Permission denied: external_directory") } },
        })
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    ))
})

describe("ShellTool conditional process substitution", () => {
  const test = isWindows || !Bun.which("bash") ? permissionIt.live.skip : permissionIt.live
  test("a nested deny prevents the substitution from running", () =>
    withScanner(
      (registry, directory) =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [
                { action: "shell", resource: "*", effect: "allow" },
                { action: "shell", resource: "printf *", effect: "deny" },
              ]
            }),
          )
          const marker = path.join(directory.active, "marker")
          const result = yield* runPermissionCommand(
            registry,
            '[[ -n <(printf reached > marker) ]]; wait "$!"',
            marker,
            [],
          )
          expect(result.exit).toMatchObject({
            _tag: "Success",
            value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
          })
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }),
      "bash",
    ))

  for (const reply of ["reject", "once", "always"] as const) {
    test(`conditional substitutions respect ${reply}`, () =>
      withScanner(
        (registry, directory) =>
          Effect.gen(function* () {
            const saved = yield* PermissionSaved.Service
            const location = yield* Location.Service
            yield* saved.add({ projectID: location.project.id, action: "shell", resources: ["wait *"] })
            const marker = path.join(directory.active, "marker")
            const command = '[[ -n <(printf reached > marker) ]]; wait "$!"'
            const result = yield* runPermissionCommand(registry, command, marker, [reply])
            expect(result.requests).toMatchObject([
              { action: "shell", resources: ["printf reached > marker", 'wait "$!"'], save: ["printf *", "wait *"] },
            ])
            if (reply === "reject") {
              expect(Exit.isFailure(result.exit)).toBe(true)
              expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
              return
            }
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: { status: "completed", metadata: { exit: 0 } },
            })
            expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("reached")
            yield* Effect.promise(() => fs.unlink(marker))
            const repeat = yield* runPermissionCommand(
              registry,
              command,
              marker,
              reply === "always" ? [] : ["reject"],
            )
            expect(repeat.requests).toHaveLength(reply === "always" ? 0 : 1)
            expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(reply === "always")
          }),
        "bash",
      ))
  }
})

describe("ShellTool compound syntax approval compatibility", () => {
  for (const fixture of [
    {
      shell: "zsh",
      command: 'for value (a b) printf %s "$value"',
      output: "ab",
      saved: ["printf *"],
    },
    {
      shell: "zsh",
      command: 'for value (a b) { printf %s "$value"; }',
      output: "ab",
      saved: ["printf *"],
    },
    {
      shell: "zsh",
      command: 'for value ($(printf a)) do printf %s "$value"; done',
      output: "a",
      saved: ["printf *"],
    },
    {
      shell: "bash",
      command: 'probe() for value in a b; do printf %s "$value"; done; probe',
      output: "ab",
      saved: ["printf *", "probe *"],
    },
    {
      shell: "bash",
      command: 'printf %s "$(probe() case value in (value) printf hello;; esac; probe)"',
      output: "hello",
      saved: ["printf *", "probe *"],
    },
  ]) {
    const test = isWindows || !Bun.which(fixture.shell) ? permissionIt.live.skip : permissionIt.live
    test(`${fixture.shell}: ${fixture.command}`, () =>
      withScanner(
        (registry, directory) =>
          Effect.gen(function* () {
            const saved = yield* PermissionSaved.Service
            const location = yield* Location.Service
            yield* saved.add({ projectID: location.project.id, action: "shell", resources: fixture.saved })
            const result = yield* runPermissionCommand(
              registry,
              fixture.command,
              path.join(directory.active, "marker"),
              [],
            )
            expect(result.requests).toEqual([])
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: {
                status: "completed",
                metadata: { exit: 0 },
                content: handleContent(fixture.output),
              },
            })
          }),
        fixture.shell,
      ))
  }
})

describe("ShellTool ordinary shell syntax", () => {
  for (const shell of ["bash", "zsh"]) {
    const test = isWindows || !Bun.which(shell) ? permissionIt.live.skip : permissionIt.live
    for (const fixture of [
      { name: "quoted heredoc", command: "cat <<'EOF'\nhello\nEOF", output: "hello\n", saved: ["cat *"] },
      {
        name: "heredoc substitution",
        command: "cat <<EOF\n$(printf hello)\nEOF",
        output: "hello\n",
        saved: ["cat *", "printf *"],
      },
      {
        name: "loop with a conditional",
        command: 'for value in a b; do if test -n "$value"; then printf %s "$value"; fi; done',
        output: "ab",
        saved: ["test *", "printf *"],
      },
      {
        name: "function and case",
        command: 'greet() { case "$1" in a) printf hello;; *) printf other;; esac; }; greet a',
        output: "hello",
        saved: ["greet *", "printf *"],
      },
      {
        name: "parameter fallback",
        command: 'value=; printf %s "${value:-fallback}"',
        output: "fallback",
        saved: ["printf *"],
      },
      {
        name: "arithmetic statement",
        command: 'count=1; ((count += 1)); printf %s "$count"',
        output: "2",
        saved: ["((count += 1)) *", "printf *"],
      },
      { name: "ANSI-C quoting", command: "printf %s $'a\\nb'", output: "a\nb", saved: ["printf *"] },
    ]) {
      test(`${shell}: ${fixture.name} reuses existing approvals`, () =>
        withScanner(
          (registry, directory) =>
            Effect.gen(function* () {
              const saved = yield* PermissionSaved.Service
              const location = yield* Location.Service
              yield* saved.add({ projectID: location.project.id, action: "shell", resources: fixture.saved })
              const result = yield* runPermissionCommand(
                registry,
                fixture.command,
                path.join(directory.active, "marker"),
                [],
              )
              expect(result.requests).toEqual([])
              expect(result.exit).toMatchObject({
                _tag: "Success",
                value: {
                  status: "completed",
                  metadata: { exit: 0 },
                  content: handleContent(fixture.output),
                },
              })
            }),
          shell,
        ))
    }

    test(`${shell}: a loop body deny prevents execution`, () =>
      withScanner(
        (registry, directory) =>
          Effect.gen(function* () {
            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = [
                  { action: "shell", resource: "*", effect: "allow" },
                  { action: "shell", resource: "printf *", effect: "deny" },
                ]
              }),
            )
            const marker = path.join(directory.active, "marker")
            const result = yield* runPermissionCommand(
              registry,
              "for value in a; do printf body > marker; done",
              marker,
              [],
            )
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
            })
            expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
          }),
        shell,
      ))
  }

  const pwsh = process.env.SHELL_SCAN_PWSH ?? Bun.which("pwsh") ?? Bun.which("powershell")
  const test = pwsh ? permissionIt.live : permissionIt.live.skip
  for (const command of [
    'Write-Output "$(Write-Output hello)"',
    '$value = "hello"; Write-Output $value',
    "if ($true) { Write-Output hello } else { Write-Output other }",
    "foreach ($value in @('hello')) { Write-Output $value }",
    "ForEach-Object { Write-Output hello }",
    "function Show-Value { Write-Output hello }; Show-Value",
    "Write-Output `\n  hello",
    "Write-Output @'\nhello\n'@",
  ]) {
    test(`PowerShell: ordinary syntax reuses approvals: ${command}`, () =>
      withScanner(
        (registry, directory) =>
          Effect.gen(function* () {
            const saved = yield* PermissionSaved.Service
            const location = yield* Location.Service
            yield* saved.add({
              projectID: location.project.id,
              action: "shell",
              resources: ["Write-Output *", "Show-Value *"],
            })
            const result = yield* runPermissionCommand(registry, command, path.join(directory.active, "marker"), [])
            expect(result.requests).toEqual([])
            expect(result.exit).toMatchObject({
              _tag: "Success",
              value: { status: "completed", metadata: { exit: 0 } },
            })
            if (Exit.isSuccess(result.exit))
              expect(result.exit.value.content?.[1]).toEqual(Expected.text(isWindows ? "hello\r\n" : "hello\n"))
          }),
        pwsh ?? "pwsh",
      ))
  }

  for (const [command, pattern] of [
    ["Write-Output\thello", "Write-Output\t*"],
    ["& 'Write-Output' hello", "& 'Write-Output' *"],
    ["Write-Output `\n  hello", "Write-Output *"],
  ]) {
    test(`PowerShell: always allow covers repeat execution and preserves exact deny: ${command}`, () =>
      withScanner(
        (registry, directory) =>
          Effect.gen(function* () {
            const marker = path.join(directory.active, "marker")
            const first = yield* runPermissionCommand(registry, command, marker, ["always"])
            expect(first.requests).toMatchObject([{ action: "shell", resources: [command], save: [pattern] }])
            expect(first.exit).toMatchObject({ _tag: "Success", value: { status: "completed", metadata: { exit: 0 } } })
            const repeat = yield* runPermissionCommand(registry, command, marker, [])
            expect(repeat.requests).toEqual([])
            expect(repeat.exit).toMatchObject({
              _tag: "Success",
              value: { status: "completed", metadata: { exit: 0 } },
            })

            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(toolIdentity.agent, (agent) => {
                agent.permissions = [{ action: "shell", resource: command, effect: "deny" }]
              }),
            )
            const denied = yield* runPermissionCommand(registry, command, marker, [])
            expect(denied.exit).toMatchObject({
              _tag: "Success",
              value: { status: "error", error: { message: expect.stringContaining("Permission denied: shell") } },
            })
          }),
        pwsh ?? "pwsh",
      ))
  }
})

describe("ShellTool", () => {
  it.live("returns both parallel CodeMode shell results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* registry.transform((editor) =>
              editor.update("shell", (tool) => {
                tool.options = { ...tool.options, codemode: true }
              }),
            )
            const command = isWindows ? helloCommand : `${helloCommand}; sleep 0.1`
            const inputs = ["one", "two"].map((text) => JSON.stringify({ command: command.replace("hello", text) }))
            const result = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-parallel-shells",
                name: "execute",
                input: { code: `return await Promise.all([tools.shell(${inputs[0]}), tools.shell(${inputs[1]})])` },
              },
            }).pipe(Effect.timeout("3 seconds"))
            expect(result.status).toBe("completed")
            expect(JSON.parse(result.output.output)).toMatchObject([
              { id: expect.stringMatching(/^sh_/), state: "exited", exitCode: 0, output: "one", truncated: false },
              { id: expect.stringMatching(/^sh_/), state: "exited", exitCode: 0, output: "two", truncated: false },
            ])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  productionIt.live(
    "registers and returns real successful output from the active Location",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const definitions = yield* toolDefinitions(registry)
              const definition = definitions.find((tool) => tool.name === "shell")
              expect(definition?.description).toStartWith("Execute a shell command and return its handle")
              expect(definition?.inputSchema).not.toHaveProperty("properties.timeout.maximum")
              // Code Mode receives the declared output schema: a handle, with the command output text, or a list.
              expect(definition?.outputSchema).toHaveProperty("anyOf.0.properties.output")
              expect(definition?.outputSchema).toHaveProperty("anyOf.1.properties.shells")
              expect(
                (yield* toolDefinitions(registry, [{ action: "shell", resource: "*", effect: "deny" }])).map(
                  (tool) => tool.name,
                ),
              ).not.toContain("shell")

              const settled = yield* executeTool(registry, call({ command: helloCommand }))
              expect(settled.status).toBe("completed")
              expect(settled.metadata).toMatchObject({ exit: 0, truncated: false })
              expect(settled.content).toEqual(handleContent("hello"))
              expect(assertions).toMatchObject([
                {
                  sessionID,
                  action: "shell",
                  resources: isWindows
                    ? ["[Console]::Out.Write('hello')", "Start-Sleep -Milliseconds 100"]
                    : [helloCommand],
                  agent: toolIdentity.agent,
                  source: { type: "tool", messageID: toolIdentity.messageID, id: "call-shell" },
                },
              ])
              expect(assertions[0]?.save).toEqual(
                isWindows ? ["[Console]::Out.Write(*", "Start-Sleep *"] : ["printf *"],
              )
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  productionIt.live(
    "uses the session environment instead of the server environment",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              yield* sessions.environment({
                sessionID,
                variables: { OPENCODE_SESSION_ENV_TEST: "from-session" },
              })
              const command = isWindows
                ? "[Console]::Out.Write($env:OPENCODE_SESSION_ENV_TEST)"
                : 'printf %s "$OPENCODE_SESSION_ENV_TEST"'

              const settled = yield* executeTool(registry, call({ command }))

              expect(settled.status).toBe("completed")
              expect(settled.content?.[1]).toEqual({ type: "text", text: "from-session" })
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  productionIt.live(
    "identifies agent shell commands without inheriting a stale session ID",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              yield* sessions.environment({
                sessionID,
                variables: { AGENT: "0", OPENCODE: "0", AI_AGENT: "", OPENCODE_SESSION_ID: "stale" },
              })
              const command = isWindows
                ? '[Console]::Out.Write("$env:AGENT|$env:OPENCODE|$env:AI_AGENT|$env:OPENCODE_SESSION_ID")'
                : 'printf %s "$AGENT|$OPENCODE|$AI_AGENT|$OPENCODE_SESSION_ID"'
              const settled = yield* executeTool(registry, call({ command }))

              expect(settled.status).toBe("completed")
              expect(settled.content?.[1]).toEqual({ type: "text", text: `1|1|opencode|${sessionID}` })
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  productionIt.live(
    "preserves an outer AI_AGENT marker in agent shell commands",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              yield* sessions.environment({ sessionID, variables: { AI_AGENT: "outer-agent" } })
              const command = isWindows ? "[Console]::Out.Write($env:AI_AGENT)" : 'printf %s "$AI_AGENT"'
              const settled = yield* executeTool(registry, call({ command }))

              expect(settled.status).toBe("completed")
              expect(settled.content?.[1]).toEqual({ type: "text", text: "outer-agent" })
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withSession(tmp.path, (registry) => executeTool(registry, call({ command: cwdCommand, workdir: "src" }))),
          ),
          Effect.andThen((settled) =>
            Effect.sync(() =>
              expect(settled.content?.[1]).toMatchObject(
                Expected.text(expect.stringContaining(realpathSync(path.join(tmp.path, "src")))),
              ),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("reports a missing workdir", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          executeTool(registry, call({ command: cwdCommand, workdir: "missing" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() =>
              expect(settled).toEqual({
                status: "error",
                error: {
                  type: "unknown",
                  message: `Working directory does not exist: ${path.join(tmp.path, "missing")}`,
                },
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "permissions compound commands separately",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: "printf one && printf two" }, "call-compound")),
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(assertions).toHaveLength(1)
                expect(assertions[0]).toMatchObject({
                  resources: ["printf one", "printf two"],
                  save: ["printf *", "printf *"],
                })
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "captures stderr-only and mixed stdout/stderr output",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const stderr = yield* executeTool(registry, call({ command: stderrCommand }, "call-stderr"))
              expect(stderr.metadata).toMatchObject({ exit: 0, truncated: false })
              expect(stderr.content?.[1]).toEqual({ type: "text", text: "stderr only" })

              const mixed = yield* executeTool(registry, call({ command: mixedOutputCommand }, "call-mixed"))
              expect(mixed.metadata).toMatchObject({ exit: 0, truncated: false })
              const output = mixed.content?.[1]?.type === "text" ? mixed.content[1].text : ""
              expect(output).toContain("stdout")
              expect(output).toContain("stderr")
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "shell"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withSession(tmp.path, (registry) => executeTool(registry, call({ command: cwdCommand, workdir: "src" }))),
          ),
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled).toMatchObject({
                status: "error",
                error: { message: `Working directory is not a directory: ${workdir}` },
              })
              expect(assertions.map((input) => input.action)).toEqual(["shell"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "approves an explicit external workdir before shell execution",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) => {
          reset()
          return withSession(active.path, (registry) =>
            executeTool(registry, call({ command: cwdCommand, workdir: outside.path })),
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(assertions.map((item) => item.action)).toEqual(["external_directory", "shell"])
                expect(assertions[0]).toMatchObject({
                  resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
                })
              }),
            ),
          )
        },
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "deduplicates external directory approvals across workdir and directory-change commands",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) => {
          const command = isWindows
            ? `Set-Location -LiteralPath '${outside.path}'; (Get-Location).Path`
            : `cd '${outside.path}' && pwd`
          return withSession(active.path, (registry) =>
            Effect.forEach([{ command }, { command, workdir: outside.path }], (input) =>
              Effect.gen(function* () {
                reset()
                const settled = yield* executeTool(registry, call(input, "call-external-cd"))
                expect(settled).toMatchObject({ status: "completed" })
                expect(assertions.map((item) => item.action)).toEqual(["external_directory", "shell"])
                expect(assertions[0]).toMatchObject({
                  resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
                  sessionID,
                  agent: toolIdentity.agent,
                  source: { type: "tool", messageID: toolIdentity.messageID, id: "call-external-cd" },
                })
              }),
            ),
          )
        },
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 15_000 },
  )

  it.live("approves an expanded external home directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const command = isWindows ? "Set-Location $HOME; (Get-Location).Path" : "cd ~ && pwd"
        return withSession(tmp.path, (registry) => executeTool(registry, call({ command }, "call-external-home"))).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "shell"])
              expect(assertions[0]?.resources[0]).toStartWith(os.homedir().replaceAll("\\", "/"))
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "does not execute after external-directory or shell denial",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) =>
          Effect.gen(function* () {
            reset()
            denyAction = "external_directory"
            yield* withSession(active.path, (registry) =>
              executeTool(registry, call({ command: cwdCommand, workdir: outside.path })),
            )
            expect(assertions.map((item) => item.action)).toEqual(["external_directory"])

            reset()
            denyAction = "shell"
            yield* withSession(active.path, (registry) => executeTool(registry, call({ command: cwdCommand })))
            expect(assertions.map((item) => item.action)).toEqual(["shell"])
          }),
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    { timeout: 15_000 },
  )

  it.live("rejects malformed syntax across channels without partial execution", () =>
    Effect.gen(function* () {
      if (isWindows) return
      for (const channel of ["local", "dev", "latest"] as const) {
        const channelSupervisor = makeLocationNode({
          name: `test/shell-plugins-${channel}`,
          layer: Layer.effectDiscard(
            registerToolPlugin(ShellTool.Plugin, {
              app: { name: "opencode", version: "test", channel },
            }),
          ),
          deps: [
            Config.node,
            Environment.node,
            FileAccess.node,
            Permission.node,
            Session.node,
            Job.node,
            Shell.node,
            ShellSelect.node,
            Tool.node,
          ],
        })
        yield* Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              reset()
              const settled = yield* withSession(tmp.path, (registry) =>
                Effect.gen(function* () {
                  const selection = yield* ShellSelect.Service
                  yield* selection.transform((editor) => editor.configure("sh"))
                  return yield* executeTool(
                    registry,
                    call({ command: 'printf hello > marker\necho "' }, `call-channel-${channel}`),
                  )
                }),
              )
              expect(settled).toMatchObject({
                status: "error",
                error: { message: expect.stringContaining("unterminated-quote") },
              })
              expect(assertions).toEqual([])
              expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "marker")).exists())).toBe(false)
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(nodes, [...replacements, PluginSupervisor.node.replace(channelSupervisor)]),
              ),
            ),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        )
      }
    }),
  )

  for (const shell of ["sh", "zsh"]) {
    const test = isWindows || !Bun.which(shell) ? it.live.skip : it.live
    test(
      `preserves arithmetic and directory permissions in ${shell}`,
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              reset()
              yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "one", "two"), { recursive: true }))
              yield* withSession(tmp.path, (registry) =>
                Effect.gen(function* () {
                  const selection = yield* ShellSelect.Service
                  yield* selection.transform((editor) => editor.configure(shell))
                  for (const [command, output] of [
                    ["echo $((1 + 1))", "2\n"],
                    ["cd ~ && pwd", `${realpathSync(os.homedir())}\n`],
                    ["cd one&&cd two&&pwd", `${path.join(tmp.path, "one", "two")}\n`],
                  ]) {
                    const settled = yield* executeTool(registry, call({ command }, `call-parity-${command}`))
                    expect(settled.status).toBe("completed")
                    expect(settled.metadata).toMatchObject({ exit: 0 })
                    expect(settled.content?.[1]).toMatchObject({ type: "text", text: output })
                  }
                }),
              )
              expect(assertions.map((item) => item.action)).toEqual([
                "shell",
                "external_directory",
                "shell",
                "shell",
              ])
              expect(assertions[1]?.resources).toEqual([path.join(realpathSync(os.homedir()), "*")])
              expect(assertions[0]).toMatchObject({ resources: ["echo $((1 + 1))"], save: ["echo *"] })
              expect(assertions[2]).toMatchObject({ resources: ["pwd"], save: ["pwd *"] })
              expect(assertions[3]).toMatchObject({ resources: ["pwd"], save: ["pwd *"] })
            }),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 15_000 },
    )
  }

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          executeTool(registry, call({ command: bodyExitCommand }, "call-nonzero")),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.status).toBe("completed")
              expect(settled.metadata).toMatchObject({ exit: 7, truncated: false })
              expect(settled.metadata).toMatchObject({ state: "exited", exitCode: 7 })
              expect(settled.content).toEqual(handleContent("body", "exited 7"))
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "truncates the model view and points at the saved output file when output overflows",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          const bytes = ToolOutput.MAX_BYTES + 1024
          return withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: overflowCommand(bytes) }, "call-overflow")),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.metadata).toMatchObject({ exit: 0, truncated: true })
                const content = settled.content?.[1]
                if (!content || content.type !== "text") throw new Error("Expected text content")
                expect(content.text.includes("output-start")).toBe(false)
                expect(content.text.includes("output-end")).toBe(true)
                expect(content).toMatchObject(Expected.text(expect.stringContaining("full output saved to ")))
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("uses configured line limits", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({ tool_output: { max_lines: 2, max_bytes: 1_000 } }),
            ),
          )
          const settled = yield* withSession(tmp.path, (registry) =>
            executeTool(registry, call({ command: lineOverflowCommand }, "call-line-overflow")),
          )
          expect(settled.metadata).toMatchObject({ exit: 0, truncated: true })
          const content = settled.content?.[1]
          if (!content || content.type !== "text") throw new Error("Expected text content")
          expect(content.text).not.toContain("one")
          // Windows shells emit CRLF; the assertion targets line limits, not line endings.
          expect(content.text.replaceAll("\r\n", "\n")).toStartWith("two\nthree")
          expect(content.text).toContain("full output saved to ")
        })
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "reports the shell ID for a running command",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          const release = "shell-progress-release"
          const releasePath = path.join(tmp.path, release)
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const observed = yield* Deferred.make<string>()
              yield* executeTool(registry, {
                ...call({ command: progressOverflowCommand(ToolOutput.MAX_BYTES + 1024, release) }, "call-progress"),
                progress: (update) =>
                  Effect.gen(function* () {
                    if (typeof update.shellID !== "string") return
                    yield* Deferred.succeed(observed, update.shellID)
                    yield* Effect.promise(() => fs.writeFile(releasePath, ""))
                  }),
              })

              expect(yield* Deferred.await(observed)).toMatch(/^sh_/)
            }).pipe(Effect.ensuring(Effect.promise(() => fs.writeFile(releasePath, "")).pipe(Effect.ignore))),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live(
    "reports shell ID progress once",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const updates: Tool.Metadata[] = []
              yield* executeTool(registry, {
                ...call({ command: helloCommand }, "call-shell-id-progress"),
                progress: (update) => Effect.sync(() => updates.push(update)),
              })
              expect(updates).toHaveLength(1)
              expect(updates[0]?.shellID).toMatch(/^sh_/)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("returns a running handle at once for a background command", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            )
            const settled = yield* executeTool(registry, call({ command: idleCommand, timeout: 50, background: true }))
            const shellID = typeof settled.metadata?.shellID === "string" ? settled.metadata.shellID : undefined
            expect(shellID).toStartWith("sh_")
            expect(settled.metadata).toMatchObject({
              id: shellID,
              state: "running",
              backgrounded: "start",
              status: "running",
              truncated: false,
            })
            expect(settled.output).toMatchObject({ id: shellID, state: "running", backgrounded: "start", output: "" })

            const shell = yield* Shell.Service
            if (!shellID) return
            const id = ID.make(shellID)
            const info = yield* shell.get(id)
            expect(settled.content).toEqual([
              {
                type: "text",
                text: expect.stringMatching(new RegExp(`^${shellID} · running · \\d.* s · started in the background$`)),
              },
              { type: "text", text: "(no output yet)" },
              {
                type: "text",
                text: expect.stringContaining(
                  `shell({ action: "check", id: "${shellID}" }) checks it, shell({ action: "wait", id: "${shellID}", ms: <ms> }) waits for it to end, shell({ action: "kill", id: "${shellID}" }) stops it. Output is streaming to: ${info.file}`,
                ),
              },
            ])
            expect((yield* shell.list()).map((info) => info.id)).toContain(id)
            expect((yield* shell.wait(id)).status).toBe("timeout")
            // The end notice carries the final handle.
            expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.item.payload).toMatchObject({
              text: expect.stringContaining(`${shellID} · timed out, killed`),
              description: idleCommand,
              metadata: {
                source: "shell",
                shellID,
                state: "completed",
                timeout: true,
                truncated: false,
                handle: { id: shellID, state: "killed", timedOut: true },
              },
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("preserves a background command's non-zero exit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            )
            const settled = yield* executeTool(
              registry,
              call({ command: bodyExitCommand, background: true }, "call-background-nonzero"),
            )
            const shellID = settled.metadata?.shellID
            expect(typeof shellID).toBe("string")
            expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.item.payload).toMatchObject({
              text: expect.stringMatching(new RegExp(`${shellID} · exited 7 · .*\\nbody`)),
              description: bodyExitCommand,
              metadata: {
                source: "shell",
                jobID: shellID,
                shellID,
                state: "completed",
                exit: 7,
                truncated: false,
                handle: { id: shellID, state: "exited", exitCode: 7 },
              },
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("persists a silent command that finishes before backgrounding", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const jobs = yield* Job.Service
            const shell = yield* Shell.Service
            const persisted = yield* Deferred.make<readonly Job.Background[]>()
            yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
              event.data.sessionID === sessionID && event.data.item.type === "synthetic"
                ? jobs.pendingBackground.pipe(
                    Effect.flatMap((background) => Deferred.succeed(persisted, background)),
                    Effect.asVoid,
                  )
                : Effect.void,
            )
            const settled = yield* executeTool(registry, {
              ...call({ command: "exit 7", background: true }, "call-background-silent-nonzero"),
              // The command can finish while its initial progress update is being published.
              progress: (update) =>
                typeof update.shellID === "string"
                  ? shell.wait(ID.make(update.shellID)).pipe(Effect.orDie, Effect.asVoid)
                  : Effect.void,
            })

            expect(yield* Deferred.await(persisted)).toMatchObject([
              {
                id: settled.metadata?.shellID,
                status: "completed",
                output: expect.stringMatching(/^sh_\w+ · exited 7 · .*\n\(no output\)$/),
              },
            ])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "updates and clears a running shell timeout",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const shell = yield* Shell.Service
              const timed = yield* executeTool(
                registry,
                call({ command: idleCommand, background: true }, "call-updated-timeout"),
              )
              const timedID = timed.metadata?.shellID
              expect(typeof timedID).toBe("string")
              if (typeof timedID !== "string") return
              const timedShellID = ID.make(timedID)
              yield* shell.timeout(timedShellID, 50)
              expect((yield* shell.wait(timedShellID)).status).toBe("timeout")

              const cleared = yield* executeTool(
                registry,
                call({ command: idleCommand, timeout: 50, background: true }, "call-cleared-timeout"),
              )
              const clearedID = cleared.metadata?.shellID
              expect(typeof clearedID).toBe("string")
              if (typeof clearedID !== "string") return
              const clearedShellID = ID.make(clearedID)
              yield* shell.timeout(clearedShellID, 0)
              yield* Effect.sleep(Duration.millis(100))
              expect((yield* shell.get(clearedShellID)).status).toBe("running")
              yield* shell.remove(clearedShellID)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  const signalTest = isWindows ? it.live.skip : it.live
  signalTest(
    "escalates a shell timeout when the ready process ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const ready = yield* Deferred.make<void>()
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            watch(tmp.path, (_event, filename) => {
              if (filename === "ready") Deferred.doneUnsafe(ready, Exit.void)
            }),
          ),
          (watcher) => Effect.sync(() => watcher.close()),
        )
        yield* withSession(tmp.path, () =>
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            yield* Effect.acquireUseRelease(
              // Arm the timeout only after the child announces that SIGTERM is ignored.
              shell.create({
                shell: "/bin/sh",
                command: "trap '' TERM; : > ready; while :; do sleep 60; done",
                timeout: 0,
              }),
              (info) =>
                Effect.gen(function* () {
                  yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
                  yield* shell.timeout(info.id, 1)
                  // Completion must reap the process, not only mark the command as timed out.
                  expect((yield* shell.wait(info.id).pipe(Effect.timeout("10 seconds"))).status).toBe("timeout")
                  const pid = info.pid
                  if (pid === undefined) throw new Error("Expected shell PID")
                  expect(() => process.kill(pid, 0)).toThrow()
                }),
              (info) =>
                Effect.try(() => {
                  if (info.pid !== undefined) process.kill(-info.pid, "SIGKILL")
                }).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(shell.remove(info.id)),
                ),
            )
          }),
        )
      }),
    { timeout: 30_000 },
  )

  if (!isWindows) {
    it.live("settles a shell terminated by an external signal", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const shell = yield* Shell.Service
              const settled = yield* executeTool(
                registry,
                call({ command: idleCommand, background: true }, "call-external-signal"),
              )
              const shellID = settled.metadata?.shellID
              expect(typeof shellID).toBe("string")
              if (typeof shellID !== "string") return
              const id = ID.make(shellID)
              const info = yield* shell.get(id)
              expect(typeof info.pid).toBe("number")
              if (info.pid === undefined) return

              process.kill(-info.pid, "SIGTERM")
              const result = yield* shell.wait(id).pipe(Effect.timeoutOption(Duration.seconds(1)))
              expect(result._tag).toBe("Some")
              if (result._tag === "Some") expect(result.value).toMatchObject({ status: "exited", signal: "SIGTERM" })
              expect((yield* shell.list()).map((item) => item.id)).not.toContain(id)
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )
  }

  it.live("backgrounds a foreground command when the session is signaled", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const jobs = yield* Job.Service
            const scope = yield* Scope.Scope
            const waiting = yield* executeTool(
              registry,
              call({ command: idleCommand, timeout: 0 }, "call-background-signal"),
            ).pipe(Effect.forkIn(scope, { startImmediately: true }))

            const backgroundWhenReady = (remaining = 1000): Effect.Effect<Job.Info[], Error> =>
              Effect.gen(function* () {
                const backgrounded = yield* jobs.backgroundAll({ sessionID })
                if (backgrounded.length > 0) return backgrounded
                if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for foreground shell job"))
                yield* Effect.promise(() => Bun.sleep(1))
                return yield* backgroundWhenReady(remaining - 1)
              })
            const backgrounded = yield* backgroundWhenReady()
            const settled = yield* Fiber.join(waiting)
            const shellID = typeof settled.metadata?.shellID === "string" ? settled.metadata.shellID : undefined
            expect(backgrounded).toMatchObject([{ id: shellID, type: "shell" }])
            expect(settled.metadata).toMatchObject({ truncated: false })
            expect(shellID).toStartWith("sh_")

            const shell = yield* Shell.Service
            if (!shellID) return
            const id = ID.make(shellID)
            const info = yield* shell.get(id)
            expect(settled.metadata).toMatchObject({ id: shellID, state: "running", backgrounded: "user" })
            expect(settled.content).toEqual([
              {
                type: "text",
                text: expect.stringMatching(
                  new RegExp(`^${shellID} · running · \\d.* s · moved to the background by the user$`),
                ),
              },
              { type: "text", text: "(no output yet)" },
              { type: "text", text: expect.stringContaining(`Output is streaming to: ${info.file}`) },
            ])
            yield* Effect.sleep(Duration.millis(100))
            expect((yield* shell.get(id)).status).toBe("running")
            expect((yield* shell.list()).map((info) => info.id)).toContain(id)
            yield* shell.remove(id)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  describe("background shells", () => {
    const shellIDOf = (result: { metadata?: Record<string, unknown> }) => {
      const id = result.metadata?.shellID
      if (typeof id !== "string") throw new Error("Expected a shell ID")
      return ID.make(id)
    }

    // Synthetic notices the session receives, collected as they arrive.
    const collectNotices = Effect.gen(function* () {
      const bus = yield* Bus.Service
      const notices: Array<{ text: string; metadata?: Record<string, unknown> }> = []
      yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
        Effect.sync(() => {
          if (event.data.sessionID === sessionID && event.data.item.type === "synthetic")
            notices.push(event.data.item.payload as { text: string; metadata?: Record<string, unknown> })
        }),
      )
      return notices
    })

    const until = (check: () => Effect.Effect<boolean>, remaining = 500): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (yield* check()) return true
        if (remaining <= 0) return false
        yield* Effect.promise(() => Bun.sleep(10))
        return yield* until(check, remaining - 1)
      })

    // The test clock drives the limit: nothing moves until it is advanced past it.
    it.effect(
      "moves a foreground command to the background at its time limit",
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            reset()
            return withSession(tmp.path, (registry) =>
              Effect.gen(function* () {
                const shell = yield* Shell.Service
                const scope = yield* Scope.Scope
                const waiting = yield* executeTool(
                  registry,
                  call({ command: `printf 'first\\nsecond\\n'; ${idleCommand}`, timeout: 5_000 }, "call-limit"),
                ).pipe(Effect.forkIn(scope, { startImmediately: true }))

                const started = (remaining = 2_000): Effect.Effect<ShellInfo, Error> =>
                  Effect.gen(function* () {
                    const running = (yield* shell.list()).find((info) => info.metadata.sessionID === sessionID)
                    if (running && (yield* shell.output(running.id)).output.includes("second")) return running
                    if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for the shell"))
                    yield* Effect.promise(() => Bun.sleep(5))
                    return yield* started(remaining - 1)
                  }).pipe(Effect.orDie)
                const info = yield* started()

                yield* TestClock.adjust(Duration.millis(4_999))
                yield* Effect.promise(() => Bun.sleep(50))
                expect(waiting.pollUnsafe()).toBeUndefined()

                yield* TestClock.adjust(Duration.millis(1))
                const settled = yield* Fiber.join(waiting)
                expect(settled.metadata).toMatchObject({
                  id: info.id,
                  state: "running",
                  status: "running",
                  backgrounded: "limit",
                  shellID: info.id,
                })
                expect(settled.output).toMatchObject({ id: info.id, state: "running", output: "first\nsecond\n" })
                expect(settled.content?.[0]).toEqual({
                  type: "text",
                  text: expect.stringMatching(
                    new RegExp(`^${info.id} · running · \\d.* s · moved to the background at its 5 s limit$`),
                  ),
                })
                expect(settled.content?.[1]).toEqual({ type: "text", text: "first\nsecond" })
                // Moved, not killed: it keeps running, now tagged as background work.
                const now = yield* shell.get(info.id)
                expect(now.status).toBe("running")
                expect(now.metadata.background).toBe(true)
                yield* shell.remove(info.id)
              }),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 15_000 },
    )

    it.live(
      "a command that ends before its limit returns its handle already exited",
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            reset()
            return withSession(tmp.path, (registry) =>
              Effect.gen(function* () {
                const settled = yield* executeTool(registry, call({ command: helloCommand, timeout: 5_000 }))
                expect(settled.metadata).toMatchObject({ status: "completed", exit: 0, state: "exited", exitCode: 0 })
                expect(settled.metadata?.backgrounded).toBeUndefined()
                expect(settled.metadata?.shellID).toBeUndefined()
                expect(settled.output).toMatchObject({
                  id: expect.stringMatching(/^sh_/),
                  state: "exited",
                  exitCode: 0,
                  output: "hello",
                  next: 5,
                  truncated: false,
                })
                expect(settled.content).toEqual(handleContent("hello"))
              }),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 15_000 },
    )

    it.live(
      "notifies the session with the final handle when a command it moved to the background ends",
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            reset()
            return withSession(tmp.path, (registry) =>
              Effect.gen(function* () {
                const bus = yield* Bus.Service
                const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
                  Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
                  Stream.runHead,
                  Effect.forkScoped({ startImmediately: true }),
                )
                const settled = yield* executeTool(
                  registry,
                  call({ command: "sleep 0.5; printf finished", timeout: 100 }, "call-limit-notice"),
                )
                const shellID = shellIDOf(settled)
                expect(settled.metadata).toMatchObject({ backgrounded: "limit" })
                expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.item.payload).toMatchObject({
                  text: expect.stringMatching(new RegExp(`${shellID} · exited 0 · .*\\nfinished`)),
                  metadata: {
                    source: "shell",
                    shellID,
                    state: "completed",
                    exit: 0,
                    handle: { id: shellID, state: "exited", exitCode: 0 },
                  },
                })
              }),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 15_000 },
    )

    const posixTest = isWindows ? it.live.skip : it.live
    posixTest(
      "checks a handle for the output since the last look, by offset or last lines, and waits for its end",
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            reset()
            return withSession(tmp.path, (registry) =>
              Effect.gen(function* () {
                const shell = yield* Shell.Service
                const notices = yield* collectNotices
                const go = (step: string) => Effect.promise(() => fs.writeFile(path.join(tmp.path, step), ""))
                const settled = yield* executeTool(
                  registry,
                  call(
                    {
                      command:
                        "while [ ! -e go1 ]; do sleep 0.01; done; echo one; while [ ! -e go2 ]; do sleep 0.01; done; echo two",
                      background: true,
                    },
                    "call-check-source",
                  ),
                )
                const id = shellIDOf(settled)
                expect(settled.output).toMatchObject({ id, state: "running", output: "", next: 0 })

                yield* go("go1")
                expect(
                  yield* until(() =>
                    shell.output(id).pipe(
                      Effect.map((read) => read.output.includes("one")),
                      Effect.orDie,
                    ),
                  ),
                ).toBe(true)
                const checked = yield* executeTool(registry, call({ action: "check", id }, "call-check"))
                expect(checked.output).toMatchObject({ id, state: "running", output: "one\n", next: 4 })
                expect(checked.metadata).toMatchObject({ id, state: "running", next: 4 })
                expect(checked.metadata?.exit).toBeUndefined()
                expect(checked.content).toEqual([
                  { type: "text", text: expect.stringMatching(new RegExp(`^${id} · running · .* · next 4$`)) },
                  { type: "text", text: "one\n" },
                ])

                // Nothing new since that look.
                const again = yield* executeTool(registry, call({ action: "check", id }, "call-check-again"))
                expect(again.output).toMatchObject({ output: "", next: 4 })
                expect(again.content?.[1]).toEqual({ type: "text", text: "(no new output)" })

                const short = yield* executeTool(registry, call({ action: "wait", id, ms: 200 }, "call-wait-short"))
                expect(short.output).toMatchObject({ id, state: "running", output: "" })
                expect(textOf(short)).toContain("still running after waiting 0.2 s")

                yield* go("go2")
                const waited = yield* executeTool(registry, call({ action: "wait", id }, "call-wait"))
                expect(waited.output).toMatchObject({ id, state: "exited", exitCode: 0, output: "two\n", next: 8 })
                expect(textOf(waited)).toMatch(new RegExp(`^${id} · exited 0 · `))

                const last = yield* executeTool(registry, call({ action: "check", id, lines: 1 }, "call-lines"))
                expect(last.output).toMatchObject({ state: "exited", output: "two\n", next: 8 })
                const from = yield* executeTool(registry, call({ action: "check", id, offset: 0 }, "call-offset"))
                expect(from.output).toMatchObject({ output: "one\ntwo\n", next: 8 })
                const rest = yield* executeTool(registry, call({ action: "check", id, offset: 4 }, "call-offset-rest"))
                expect(rest.output).toMatchObject({ output: "two\n", next: 8 })

                // The wait that saw the end answered the agent: no notice follows.
                yield* Effect.promise(() => Bun.sleep(200))
                expect(notices).toEqual([])
              }),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 20_000 },
    )

    it.live(
      "lists and acts on only the session's own shells",
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            reset()
            return withSession(tmp.path, (registry) =>
              Effect.gen(function* () {
                const shell = yield* Shell.Service
                const settled = yield* executeTool(
                  registry,
                  call(
                    { command: "printf 'one\\ntwo\\nthree\\n'", description: "count to three", background: true },
                    "call-read-source",
                  ),
                )
                const shellID = shellIDOf(settled)
                yield* shell.wait(shellID)
                const other = yield* shell.create({
                  command: "printf other",
                  metadata: { sessionID: "ses_someone_else" },
                })
                yield* shell.wait(other.id)

                const listed = yield* executeTool(registry, call({ action: "list" }, "call-list"))
                expect(listed.output).toEqual({
                  shells: [
                    {
                      id: shellID,
                      description: "count to three",
                      command: "printf 'one\\ntwo\\nthree\\n'",
                      state: "exited",
                      exitCode: 0,
                      runtimeMs: expect.any(Number),
                      size: 14,
                      started: expect.any(Number),
                      background: true,
                    },
                  ],
                })
                expect(listed.content).toEqual([
                  {
                    type: "text",
                    text: expect.stringMatching(new RegExp(`^${shellID} · exited 0 · .* · 14 bytes · count to three$`)),
                  },
                ])

                const foreign = yield* executeTool(registry, call({ action: "check", id: other.id }, "call-foreign"))
                expect(foreign).toMatchObject({
                  status: "error",
                  error: { message: expect.stringContaining(`No shell ${other.id} in this session. Its shells: ${shellID}`) },
                })
                const killForeign = yield* executeTool(registry, call({ action: "kill", id: other.id }, "call-kill-foreign"))
                expect(killForeign.status).toBe("error")
                expect((yield* shell.get(other.id)).status).toBe("exited")
              }),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 15_000 },
    )

    test("offers one flat object with an action enum and no flag fields", () => {
      const schema = definition({ name: "shell", description: "", input: ShellTool.Input, execute: () => Effect.die("unused") }).inputSchema
      // A root union is what providers reject; the root stays a plain object.
      expect(schema).not.toHaveProperty("anyOf")
      expect(schema).not.toHaveProperty("oneOf")
      expect(schema).not.toHaveProperty("allOf")
      expect(schema).toMatchObject({
        type: "object",
        properties: { action: { type: "string", enum: ["run", "check", "wait", "kill", "list"] } },
      })
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
        ["action", "background", "command", "description", "id", "lines", "ms", "offset", "timeout", "workdir"],
      )
      expect(schema).not.toHaveProperty("required")
    })

    const failure = (message: string | ReturnType<typeof expect.stringContaining>) => ({ status: "error", error: { message } })

    it.live("rejects a field that is not its action's, a missing id or command, and an unknown field", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const run = (input: typeof ShellTool.Input.Type) => executeTool(registry, call(input, `call-${Permission.ID.create()}`))
              expect(yield* run({ command: helloCommand, id: "sh_x" })).toMatchObject(
                failure('action "run" takes command, workdir, timeout, description, background, not id.'),
              )
              expect(yield* run({ action: "kill", id: "sh_x", lines: 3 })).toMatchObject(
                failure('action "kill" takes id, not lines.'),
              )
              expect(yield* run({ action: "check", id: "sh_x", ms: 10 })).toMatchObject(
                failure('action "check" takes id, offset, lines, not ms.'),
              )
              expect(yield* run({ action: "list", command: helloCommand })).toMatchObject(
                failure('action "list" takes no other fields, not command.'),
              )
              expect(yield* run({ action: "wait", ms: 10 })).toMatchObject(
                failure('action "wait" needs id, the shell ID (sh_…) a shell call returned.'),
              )
              expect(yield* run({ action: "run" })).toMatchObject(failure('action "run" needs command.'))
              expect(yield* run({ action: "check", id: "sh_x", offset: 0, lines: 1 })).toMatchObject(
                failure("Give offset or lines, not both."),
              )
              expect(yield* run({})).toMatchObject(failure(expect.stringContaining("Give command to run a command")))
              expect(yield* run({ id: "sh_x" })).toMatchObject(
                failure(
                  'Give the action to take on sh_x: { action: "check", id: "sh_x" }, { action: "wait", id: "sh_x", ms } or { action: "kill", id: "sh_x" }.',
                ),
              )
              expect(yield* run({ command: helloCommand, cwd: "src" })).toMatchObject(
                failure("The shell tool has no field cwd; it takes action and the fields of that action."),
              )
              // Nothing ran.
              expect(assertions).toEqual([])
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )

    it.live("rejects the flag forms that came before actions, naming the action form", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const run = (input: typeof ShellTool.Input.Type) => executeTool(registry, call(input, `call-${Permission.ID.create()}`))
              expect(yield* run({ id: "sh_x", kill: true })).toMatchObject(
                failure('The shell tool has no kill field; use { action: "kill", id: "sh_x" }.'),
              )
              expect(yield* run({ list: true })).toMatchObject(
                failure('The shell tool has no list field; use { action: "list" }.'),
              )
              expect(yield* run({ id: "sh_x", wait: 500 })).toMatchObject(
                failure('The shell tool has no wait field; use { action: "wait", id: "sh_x", ms }.'),
              )
              // Even beside a command, or an action.
              expect(yield* run({ command: helloCommand, wait: 10 })).toMatchObject(
                failure('The shell tool has no wait field; use { action: "wait", id: "sh_…", ms }.'),
              )
              expect(yield* run({ action: "check", id: "sh_x", kill: true })).toMatchObject(
                failure('The shell tool has no kill field; use { action: "kill", id: "sh_x" }.'),
              )
              expect(assertions).toEqual([])
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )

    it.live("runs a command given with action run, as without it", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const named = yield* executeTool(registry, call({ action: "run", command: helloCommand }, "call-action-run"))
              const bare = yield* executeTool(registry, call({ command: helloCommand }, "call-bare-run"))
              expect(named.content).toEqual(handleContent("hello"))
              expect(bare.content).toEqual(handleContent("hello"))
              expect(named.output).toMatchObject({ state: "exited", exitCode: 0, output: "hello" })
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )

    posixTest(
      "a user kill of a background shell notifies the session with its final handle",
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            reset()
            return withSession(tmp.path, (registry) =>
              Effect.gen(function* () {
                const shell = yield* Shell.Service
                const bus = yield* Bus.Service
                const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
                  Stream.filter((event) => event.data.sessionID === sessionID && event.data.item.type === "synthetic"),
                  Stream.runHead,
                  Effect.forkScoped({ startImmediately: true }),
                )
                const settled = yield* executeTool(
                  registry,
                  call({ command: `echo up; ${idleCommand}`, background: true }, "call-user-kill"),
                )
                const id = shellIDOf(settled)
                // The dock's kill: straight to the shell service, not through the agent's tool.
                yield* shell.kill(id)
                expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.item.payload).toMatchObject({
                  text: expect.stringContaining(`${id} · killed SIGTERM`),
                  metadata: { source: "shell", shellID: id, signal: "SIGTERM", handle: { id, state: "killed", signal: "SIGTERM" } },
                })
              }),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 15_000 },
    )

    posixTest(
      "kill ends the whole process group and returns the final handle, without a notice",
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            reset()
            return withSession(tmp.path, (registry) =>
              Effect.gen(function* () {
                const jobs = yield* Job.Service
                const notices = yield* collectNotices
                const childFile = path.join(tmp.path, "child")
                // The child ignores SIGTERM and outlives the shell that started it.
                const settled = yield* executeTool(
                  registry,
                  call(
                    {
                      command: `sh -c "trap '' TERM; echo \\$\\$ > '${childFile}'; while :; do sleep 1; done" & while [ ! -s '${childFile}' ]; do sleep 0.01; done; echo started; wait`,
                      timeout: 300,
                    },
                    "call-kill-group",
                  ),
                )
                const shellID = shellIDOf(settled)
                expect(settled.metadata).toMatchObject({ backgrounded: "limit" })
                const child = Number((yield* Effect.promise(() => fs.readFile(childFile, "utf8"))).trim())
                expect(() => process.kill(child, 0)).not.toThrow()

                const killed = yield* executeTool(registry, call({ action: "kill", id: shellID }, "call-kill"))
                expect(killed.output).toMatchObject({ id: shellID, state: "killed", signal: "SIGTERM" })
                expect(killed.metadata).toMatchObject({ id: shellID, state: "killed", signal: "SIGTERM" })
                expect(textOf(killed)).toMatch(new RegExp(`^${shellID} · killed SIGTERM · `))
                const gone = () =>
                  Effect.sync(() => {
                    try {
                      process.kill(child, 0)
                      return false
                    } catch {
                      return true
                    }
                  })
                expect(yield* until(gone)).toBe(true)

                // The kill answered the agent: its background record clears, and no notice follows.
                expect(yield* until(() => jobs.pendingBackground.pipe(Effect.map((pending) => pending.length === 0)))).toBe(
                  true,
                )
                yield* Effect.promise(() => Bun.sleep(100))
                expect(notices).toEqual([])

                const again = yield* executeTool(registry, call({ action: "kill", id: shellID }, "call-kill-again"))
                expect(again.output).toMatchObject({ id: shellID, state: "killed" })
                expect(textOf(again)).toMatch(new RegExp(`^${shellID} · killed SIGTERM · .* · it had already ended`))
              }),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 20_000 },
    )
  })
})
