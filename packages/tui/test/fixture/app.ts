import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import path from "node:path"
import { Global } from "@opencode/util/global"
import type { TuiInput } from "../../src/app"
import type { Config } from "../../src/config"
import { tmpdir } from "./fixture"
import { createEventStream, createFetch, type FetchHandler } from "./tui-client"

export async function createAppFixture(
  input: {
    width?: number
    height?: number
    state?: string
    config?: Config.Info
    args?: TuiInput["args"]
    fetch?: FetchHandler
    // A renderer whose owner already set up its terminal, such as the simulation renderer.
    setup?: TestRendererSetup
    // Theme documents by name, discovered from the config directory as the user's themes are.
    themes?: Record<string, unknown>
    // The TUI's own build.
    version?: string
    // Attached to a managed background service (this fake server), as `opencode` without --server is.
    managed?: boolean
  } = {},
) {
  const { run } = await import("../../src/app")
  const root = await tmpdir()
  for (const [name, theme] of Object.entries(input.themes ?? {}))
    await Bun.write(path.join(root.path, "config", "themes", `${name}.json`), JSON.stringify(theme))
  const setup =
    input.setup ??
    (await createTestRenderer({
      width: input.width ?? 100,
      height: input.height ?? 30,
      kittyKeyboard: true,
    }))
  if (!input.setup) await setup.renderer.setupTerminal()
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const events = createEventStream()
  const calls = createFetch(input.fetch, events)
  // Updates apply to a copy, as a config file would, so preference writes persist for the rest of the test.
  let config: Config.Info = structuredClone(input.config ?? { animations: false })
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: input.version ?? "test", channel: "test" },
      server: {
        endpoint: { url: server.url.toString() },
        service: input.managed
          ? { reconnect: async () => ({ url: server.url.toString() }), restart: async () => {} }
          : undefined,
      },
      config: {
        get: async () => config,
        update: async (mutate) => {
          const next = structuredClone(config)
          mutate(next)
          config = next
          return next
        },
      },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: input.args ?? {},
      log: () => {},
    }).pipe(
      Effect.provide(
        Global.layerWith({
          home: path.join(root.path, "home"),
          data: path.join(root.path, "data"),
          cache: path.join(root.path, "cache"),
          config: path.join(root.path, "config"),
          state: input.state ?? path.join(root.path, "state"),
          bin: path.join(root.path, "cache", "bin"),
          log: path.join(root.path, "data", "log"),
          repos: path.join(root.path, "data", "repos"),
          tmp: path.join(root.path, "tmp"),
        }),
      ),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  )
  return {
    ...setup,
    events,
    config: () => config,
    ready: ready.promise,
    // What `run` returned, once the TUI has shut down.
    task,
    async [Symbol.asyncDispose]() {
      try {
        if (!setup.renderer.isDestroyed) setup.renderer.destroy()
        await task
      } finally {
        await server.stop()
        await root[Symbol.asyncDispose]()
      }
    },
  }
}
