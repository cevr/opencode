import { afterEach, describe, expect, test } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { ServerConnection } from "./server-connection"

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

// A server answering /api/info with `refusals` 503s of the given body before the health it serves.
const serve = (refusals: number, body: unknown, port = 0) => {
  let seen = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/api/info") return new Response("not found", { status: 404 })
      if (seen++ < refusals) return Response.json(body, { status: 503, headers: { "retry-after": "0.1" } })
      return Response.json({ version: "test" })
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, port: server.port ?? 0, seen: () => seen }
}

// The --server path reads none of the managed-service context; it is provided for the types alone, with no side effect.
const resolve = (server: string, onWait?: (url: string) => void) =>
  Effect.runPromise(
    ServerConnection.resolve({ server, onWait }).pipe(
      Effect.result,
      Effect.provideService(Global.Service, Global.make()),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

describe("--server health check", () => {
  test("waits while the server is still starting, and says so once", async () => {
    const server = serve(3, { code: "service_starting" })
    const waits: string[] = []
    const resolved = await resolve(server.url, (url) => waits.push(url))
    expect(resolved._tag).toBe("Success")
    expect(server.seen()).toBe(4)
    expect(waits).toEqual([server.url])
  })

  test("waits while nothing listens (a restart's gap), then connects", async () => {
    // A port nothing listens on until the server comes up a moment later.
    const probe = serve(0, {})
    const port = probe.port
    servers.splice(0).forEach((server) => server.stop(true))
    const waits: string[] = []
    setTimeout(() => serve(1, { code: "service_starting" }, port), 1_500)
    const resolved = await resolve(`http://127.0.0.1:${port}`, (url) => waits.push(url))
    expect(resolved._tag).toBe("Success")
    expect(waits).toEqual([`http://127.0.0.1:${port}`])
  })

  test("does not say it waits for a server that serves at once", async () => {
    const waits: string[] = []
    expect((await resolve(serve(0, {}).url, (url) => waits.push(url)))._tag).toBe("Success")
    expect(waits).toEqual([])
  })

  test("still fails on a 503 that is not the service starting", async () => {
    const server = serve(Number.POSITIVE_INFINITY, { code: "overloaded" })
    const resolved = await resolve(server.url)
    expect(resolved._tag).toBe("Failure")
    expect(String(resolved._tag === "Failure" ? resolved.failure : "")).toContain(
      "did not provide a compatible V2 health response",
    )
  })
})
