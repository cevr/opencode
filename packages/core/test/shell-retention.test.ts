import { expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Queue, Scope, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Shell } from "@opencode/core/shell"
import { Workspace } from "@opencode/core/workspace"
import { Global } from "@opencode/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { location, tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// A spawner whose processes print "hello" and exit only when the test takes their completion from the queue.
const queuedEnvironment = (completions: Queue.Queue<Effect.Effect<void>>) =>
  Layer.effect(
    Environment.Service,
    Effect.gen(function* () {
      const host = yield* Environment.Service
      const scope = yield* Scope.Scope
      return Environment.Service.of({
        ...host,
        spawner: ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const exited = yield* Deferred.make<ExitCode>()
            const observer = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
            yield* Queue.offer(
              completions,
              Effect.gen(function* () {
                yield* Deferred.succeed(exited, ExitCode(0))
                // Shell.wait resolves before retention runs; join the whole exit handler instead.
                const fiber = yield* Deferred.await(observer)
                yield* Fiber.join(fiber).pipe(Effect.orDie)
              }),
            )
            const output = Stream.succeed(Buffer.from("hello"))
            return makeHandle({
              pid: ProcessId(1),
              exitCode: Effect.withFiber((fiber) =>
                Scope.addFinalizer(scope, Fiber.interrupt(fiber)).pipe(
                  Effect.andThen(Deferred.succeed(observer, fiber)),
                  Effect.andThen(Deferred.await(exited)),
                ),
              ),
              isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
              kill: () => Deferred.succeed(exited, ExitCode(0)).pipe(Effect.asVoid),
              stdin: Sink.drain,
              stdout: output,
              stderr: Stream.empty,
              all: output,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            })
          }),
        ),
      })
    }),
  ).pipe(Layer.provide(hostEnvironmentLayer))

it.live("eviction makes progress past an already-removed shell", () =>
  Effect.gen(function* () {
    const completions = yield* Queue.unbounded<Effect.Effect<void>>()
    const environment = queuedEnvironment(completions)

    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const removed = yield* shell.create({ shell: "sh", command: "removed", timeout: 0 })
      const finishRemoved = yield* Queue.take(completions)
      yield* shell.remove(removed.id)
      expect((yield* shell.result(removed)).capture).toBeUndefined()
      yield* finishRemoved

      const complete = Effect.gen(function* () {
        const info = yield* shell.create({ shell: "sh", command: "hello", timeout: 0 })
        const finish = yield* Queue.take(completions)
        yield* finish
        return info
      })
      const oldest = yield* complete
      // Exceed the 25-entry retention cap with the removed ID at the head of exitOrder.
      yield* Effect.forEach(Array.from({ length: 25 }), () => complete, { discard: true })
      expect(yield* shell.get(oldest.id).pipe(Effect.flip)).toBeInstanceOf(Shell.NotFoundError)

      const survivor = yield* complete
      expect(yield* shell.result(survivor)).toMatchObject({
        info: { status: "exited", exit: 0 },
        capture: { output: "hello", truncated: false },
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(tempLocationLayer),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(environment),
        ]),
      ),
    )
  }),
)

it.live("does not inherit host process.env when creating a shell in a workspace-backed location", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    let capturedEnv: Record<string, string | undefined> | undefined
    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const info = yield* shell.create({ shell: "/bin/sh", command: "printf ok", timeout: 0 }, (invocation) =>
        Effect.sync(() => {
          capturedEnv = { ...invocation.env }
        }),
      )
      expect(yield* shell.result(info)).toMatchObject({
        info: { status: "exited" },
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  Location.Ref.make({
                    directory: AbsolutePath.make(tmp.path),
                    workspaceID: Workspace.ID.make("wrk_workspace"),
                  }),
                ),
              ),
            ),
          ),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(hostEnvironmentLayer),
        ]),
      ),
    )

    expect(process.env.PATH).toBeDefined()
    expect(capturedEnv).toEqual({
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
    })
  }),
)

const queuedNode = (environment: ReturnType<typeof queuedEnvironment>) =>
  AppNodeBuilder.build(Shell.node, [
    Location.node.replace(tempLocationLayer),
    Global.node.replace(tempGlobalLayer),
    Config.node.replace(Config.testLayer()),
    Environment.node.replace(environment),
  ])

it.live("quick foreground commands never evict a background shell", () =>
  Effect.gen(function* () {
    const completions = yield* Queue.unbounded<Effect.Effect<void>>()
    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const complete = (metadata?: Record<string, unknown>) =>
        Effect.gen(function* () {
          const info = yield* shell.create({ shell: "sh", command: "hello", timeout: 0, ...(metadata ? { metadata } : {}) })
          const finish = yield* Queue.take(completions)
          yield* finish
          return info
        })
      const background = yield* complete({ background: true })
      const foreground = yield* complete()
      yield* Effect.forEach(Array.from({ length: 25 }), () => complete(), { discard: true })
      // The 26th foreground command pushed the oldest foreground one out; the background shell stays.
      expect(yield* shell.get(foreground.id).pipe(Effect.flip)).toBeInstanceOf(Shell.NotFoundError)
      expect((yield* shell.get(background.id)).status).toBe("exited")
      expect((yield* shell.list({ exited: true })).length).toBe(26)
      expect((yield* shell.list()).length).toBe(0)
    }).pipe(Effect.provide(queuedNode(queuedEnvironment(completions))))
  }),
)

if (process.platform !== "win32")
  it.live(
    "rotates output past the segment size and reads across both kept segments",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const shell = yield* Shell.Service
          const segment = Shell.OUTPUT_SEGMENT_BYTES
          // 2.5 segments of "a", then a marker: the second rotation drops the oldest of it.
          const total = segment * 2 + segment / 2
          const info = yield* shell.create({
            shell: "/bin/sh",
            command: `head -c ${total} /dev/zero | tr '\\0' a; printf END`,
            cwd: tmp.path,
            timeout: 0,
          })
          yield* shell.wait(info.id)
          const size = total + 3
          const latest = yield* shell.output(info.id, { cursor: Number.MAX_SAFE_INTEGER })
          expect(latest.size).toBe(size)
          const tail = yield* shell.output(info.id, { cursor: size - 5 })
          expect(tail).toMatchObject({ output: "aaEND", cursor: size, truncated: false })
          // Bytes before the older kept segment are gone; a read from 0 starts where the kept output does.
          const head = yield* shell.output(info.id, { cursor: 0, limit: 4 })
          expect(head).toMatchObject({ output: "aaaa", truncated: true })
          const earliest = head.cursor - 4
          // Two full segments at most: the dropped part is at least the first half segment.
          expect(earliest).toBeGreaterThanOrEqual(segment / 2)
          expect(size - earliest).toBeLessThanOrEqual(2 * segment)
          // One read of everything kept joins both files, in order, with nothing missing.
          const kept = yield* shell.output(info.id, { cursor: earliest, limit: size })
          expect(kept.truncated).toBe(false)
          expect(kept.cursor).toBe(size)
          expect(kept.output.length).toBe(size - earliest)
          expect(kept.output.endsWith("aEND")).toBe(true)
          expect(/^a+END$/.test(kept.output)).toBe(true)
          const files = (yield* Effect.promise(() => import("node:fs/promises").then((fs) => fs.readdir(path.dirname(info.file)))))
            .filter((name) => name.startsWith(info.id))
            .sort()
          expect(files).toEqual([`${info.id}.out`, `${info.id}.out.1`])
          const result = yield* shell.result(info)
          expect(result.capture?.output).toContain(`the first ${earliest} bytes were dropped`)
          yield* shell.remove(info.id)
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(Shell.node, [
              Location.node.replace(tempLocationLayer),
              Global.node.replace(tempGlobalLayer),
              Config.node.replace(Config.testLayer()),
              Environment.node.replace(hostEnvironmentLayer),
            ]),
          ),
        )
      }),
    { timeout: 30_000 },
  )
