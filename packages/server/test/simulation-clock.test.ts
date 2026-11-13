import { expect } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { ConfigProvider, Effect, Schedule } from "effect"
import { HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { availableEndpoint, connect } from "../../simulation/test/fixture/websocket"
import { ServerProcess } from "../src/process"
import type { ServerOptions } from "../src/options"

// A Drive-mode server runs on the simulation's clock: one `clock.advance` from the driver moves the time every
// fiber of the server reads (a plugin's timer, a request's handler) and wakes the sleeps it passes. Served only:
// the embedded host's file system is a no-op, so it cannot read a Drive manifest.

const HOUR = 3_600_000
const PLUGIN = path.join(import.meta.dir, "fixture/clock-plugin")

interface Probe {
  readonly now: number
  readonly woke: boolean
}

/** A Drive instance of the test's own: its manifest names a free backend endpoint, and the config points at it. */
const driveInstance = Effect.fnUntraced(function* () {
  const registry = yield* tmpdirScoped()
  const backend = availableEndpoint()
  writeFileSync(
    path.join(registry.path, "clock-test.json"),
    JSON.stringify({ endpoints: { ui: availableEndpoint(), backend } }),
  )
  const config = ConfigProvider.layerAdd(
    ConfigProvider.fromUnknown({ OPENCODE_DRIVE: "clock-test", DRIVE_REGISTRY_DIR: registry.path }),
  )
  return { backend, config }
})

const serverOptions = (directory: string): ServerOptions => ({
  simulation: true,
  database: { path: ":memory:" },
  models: { fetch: false },
  config: { directory, project: false, content: JSON.stringify({ plugins: [{ package: PLUGIN }] }) },
  fs: { filewatcher: false },
})

/** Reads the probe once its plugin has loaded. */
const probe = (call: (url: URL) => Promise<Response>, base: string, directory: string) => {
  const url = new URL("/api/rpc/clock-probe/read", base)
  url.searchParams.set("location[directory]", directory)
  return Effect.promise(() => call(url)).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.promise(() => response.json() as Promise<{ readonly output: Probe }>).pipe(
            Effect.map((body) => body.output),
          )
        : Effect.promise(() => response.text()).pipe(
            Effect.flatMap((body) => Effect.fail(new Error(`clock-probe answered ${response.status}: ${body}`))),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 30 }),
  )
}

/** The driver's side: a backend handshake that needs `clock.advance`, then one advance; answers the new time. */
const advance = (backend: string, ms: number) =>
  Effect.gen(function* () {
    const socket = yield* connect(backend)
    const replies: Array<unknown> = []
    socket.addEventListener("message", (event) => void replies.push(JSON.parse(String(event.data))))
    const reply = (id: number) =>
      Effect.sync(() => replies.find((message) => (message as { readonly id?: unknown }).id === id)).pipe(
        Effect.flatMap((message) =>
          message === undefined ? Effect.fail(new Error(`no reply ${id}`)) : Effect.succeed(message),
        ),
        Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }),
      )
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "simulation.handshake",
        params: {
          client: { name: "test", version: "test" },
          expectedRole: "backend",
          offeredVersions: [1],
          requiredCapabilities: ["clock.advance"],
          optionalCapabilities: [],
        },
      }),
    )
    expect(yield* reply(0)).toHaveProperty("result")
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "clock.advance", params: { ms } }))
    const advanced = (yield* reply(1)) as { readonly result?: { readonly now?: unknown } }
    if (typeof advanced.result?.now !== "number") throw new Error(`clock.advance failed: ${JSON.stringify(advanced)}`)
    return advanced.result.now
  }).pipe(Effect.scoped)

/** Before an advance the hour-long sleep has not ended; after one it has, and both read the advanced time. */
const advancesEveryFiber = (read: Effect.Effect<Probe, Error>, backend: string) =>
  Effect.gen(function* () {
    const before = yield* read
    expect(before.woke).toBe(false)
    const now = yield* advance(backend, HOUR)
    expect(now).toBeGreaterThanOrEqual(before.now + HOUR)
    const after = yield* read.pipe(
      Effect.filterOrFail(
        (probe) => probe.woke,
        () => new Error("the plugin's hour-long sleep did not end"),
      ),
      Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }),
    )
    expect(after.now).toBeGreaterThanOrEqual(now)
  })

it.live(
  "a served Drive server's plugin timers and request handlers run on the clock the driver advances",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const drive = yield* driveInstance()
      const server = yield* ServerProcess.start<never, never>({
        ...serverOptions(directory.path),
        hostname: "127.0.0.1",
        port: 0,
        password: "secret",
      }).pipe(Effect.provide(drive.config))
      const base = HttpServer.formatAddress(server.address)
      const call = (url: URL) =>
        fetch(url, {
          method: "POST",
          headers: { authorization: `Basic ${btoa("opencode:secret")}`, "content-type": "application/json" },
          body: JSON.stringify({ input: {} }),
        })
      yield* advancesEveryFiber(probe(call, base, directory.path), drive.backend)
    }),
  30_000,
)
