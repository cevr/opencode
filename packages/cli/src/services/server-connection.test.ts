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
const serve = (refusals: number, body: unknown) => {
  let seen = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/api/info") return new Response("not found", { status: 404 })
      if (seen++ < refusals) return Response.json(body, { status: 503, headers: { "retry-after": "0.1" } })
      return Response.json({ version: "test" })
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, seen: () => seen }
}

// The --server path reads none of the managed-service context; it is provided for the types alone, with no side effect.
const resolve = (server: string) =>
  Effect.runPromise(
    ServerConnection.resolve({ server }).pipe(
      Effect.result,
      Effect.provideService(Global.Service, Global.make()),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

describe("--server health check", () => {
  test("waits while the server is still starting", async () => {
    const server = serve(3, { code: "service_starting" })
    const resolved = await resolve(server.url)
    expect(resolved._tag).toBe("Success")
    expect(server.seen()).toBe(4)
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
