import { Service, type Endpoint, type EnsureOptions } from "@opencode/client/effect/service"
import { ClientError, isUnauthorizedError, OpenCode, serviceReadyFetch } from "@opencode/client/promise"
import { OPENCODE_VERSION } from "../version"
import { Effect, Option, Redacted } from "effect"
import { Server as ServerFlag, Standalone as StandaloneFlag } from "../commands/commands"
import { Env } from "../env"
import { ServiceConfig } from "./service-config"
import { Standalone } from "./standalone"
import { errorMessage } from "../util/error"

export type Args = {
  readonly server?: string
  readonly standalone?: boolean
  readonly mismatch?: "replace" | "ignore" | "error"
  /** Start the background service when none is running. When false, use a standalone server instead. */
  readonly autostart?: boolean
  readonly onStart?: EnsureOptions["onStart"]
  /** Called once when the server is there but cannot serve yet (down for a restart, or booting). */
  readonly onWait?: (url: string) => void
}

export type Resolved = {
  readonly endpoint: Endpoint
  readonly service?: ReturnType<typeof managedService>
  /** A private server started for this command alone. */
  readonly standalone?: boolean
}

export const resolve = Effect.fn("cli.server-connection.resolve")(function* (args: Args = {}) {
  const serverFlag = yield* Effect.serviceOption(ServerFlag).pipe(Effect.map(Option.flatten))
  const standaloneFlag = yield* Effect.serviceOption(StandaloneFlag)
  const server = args.server ?? Option.getOrUndefined(serverFlag)
  const standalone = args.standalone ?? Option.getOrElse(standaloneFlag, () => false)
  if (server !== undefined && standalone)
    return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
  if (server !== undefined) {
    const password = yield* Env.password
    const endpoint = {
      url: server,
      auth: password ? { type: "basic" as const, username: "opencode", password: Redacted.value(password) } : undefined,
    } satisfies Endpoint
    // A restarting server refuses connections for a moment, then answers 503 service_starting until
    // its routes are built: the check waits through both (a minute at most, each try 5 s at most), as
    // the TUI's own client does, and says once that it waits. Anything else fails at once.
    const health = yield* Effect.tryPromise({
      try: () =>
        OpenCode.make({
          baseUrl: endpoint.url,
          headers: Service.headers(endpoint),
          fetch: serviceReadyFetch(attemptTimeout(5_000), { onWait: () => args.onWait?.(endpoint.url) }),
        }).server.info(),
      catch: (cause) => connectError(endpoint, cause),
    })
    if (health.version !== OPENCODE_VERSION)
      process.stderr.write(
        `Warning: Server at ${endpoint.url} has version ${health.version}; this client is ${OPENCODE_VERSION}. Continuing anyway.\n`,
      )
    return { endpoint } satisfies Resolved
  }
  if (standalone || (yield* ServiceConfig.read()).disabled === true) {
    return { endpoint: yield* Standalone.start(), standalone: true } satisfies Resolved
  }

  const mismatch = args.mismatch ?? "ignore"
  const options = yield* ServiceConfig.options({ checkVersion: mismatch !== "ignore" })
  if (args.autostart === false) {
    const endpoint = yield* Service.discover({ ...options, version: undefined })
    if (!endpoint) return { endpoint: yield* Standalone.start(), standalone: true } satisfies Resolved
    return { endpoint, service: managedService(options) } satisfies Resolved
  }
  return {
    endpoint: yield* resolveManaged({ ...options, onStart: args.onStart, onWait: args.onWait }, mismatch),
    service: managedService(options),
  } satisfies Resolved
})

function managedService(options: EnsureOptions) {
  const reconnectOptions = { ...options, version: undefined }
  return {
    reconnect: () => Service.ensure(reconnectOptions),
    restart: () =>
      Effect.gen(function* () {
        yield* Service.stop({ file: options.file, pty: "handoff" })
        yield* Service.ensure(reconnectOptions)
      }),
  }
}

export const shutdownPersistentPty = Effect.fn("cli.server-connection.shutdown-persistent-pty")(function* (
  options: EnsureOptions,
) {
  const endpoint = yield* Service.discover({ ...options, version: undefined })
  if (!endpoint) return
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  yield* Effect.tryPromise(() => client.experimental.persistentPty.shutdown())
})

const resolveManaged = Effect.fnUntraced(function* (options: EnsureOptions, mismatch: NonNullable<Args["mismatch"]>) {
  if (mismatch === "replace") return yield* Service.ensure(options)
  if (mismatch === "ignore") return yield* Service.ensure({ ...options, version: undefined })

  const compatible = yield* Service.discover(options)
  if (compatible !== undefined) return compatible
  const existing = yield* Service.discover({ ...options, version: undefined })
  if (existing !== undefined)
    return yield* Effect.fail(new Error("Background server version does not match this client"))
  return yield* Service.ensure(options)
})

/** fetch with each request bounded on its own: a server that never answers fails the try, not the wait. */
function attemptTimeout(ms: number): typeof globalThis.fetch {
  const attempt = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const timeout = AbortSignal.timeout(ms)
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
  }
  return Object.assign(attempt, { preconnect: fetch.preconnect })
}

function connectError(endpoint: Endpoint, cause: unknown) {
  if (isUnauthorizedError(cause)) {
    return new Error(
      endpoint.auth === undefined
        ? `Server at ${endpoint.url} requires a password; set OPENCODE_PASSWORD`
        : `Server at ${endpoint.url} rejected the password`,
      { cause },
    )
  }
  if (cause instanceof ClientError && cause.reason === "Transport")
    return new Error(`Could not reach server at ${endpoint.url}: ${errorMessage(cause.cause ?? cause)}`, { cause })
  return new Error(
    `Server at ${endpoint.url} did not provide a compatible V2 health response: ${errorMessage(cause)}`,
    { cause },
  )
}

export * as ServerConnection from "./server-connection"
