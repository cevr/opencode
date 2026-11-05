import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const CompactResponse = Schema.Struct({ data: Schema.toEncoded(SessionInbox.Compaction) })

const makeRequest = Effect.fn(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  return (path: string, body: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
      return { status: response.status, body: await response.json() }
    })
})

it.live("records the reason a compaction request carries", () =>
  Effect.gen(function* () {
    const request = yield* makeRequest()
    const session = (id: string) => `/api/session/${id}/compact`
    const created = Schema.decodeUnknownSync(SessionResponse)((yield* request("/api/session", {})).body)

    const auto = yield* request(session(created.data.id), { reason: "auto", delivery: "queue" })
    expect(auto.status).toBe(200)
    expect(Schema.decodeUnknownSync(CompactResponse)(auto.body).data.payload).toEqual({ reason: "auto" })

    const other = Schema.decodeUnknownSync(SessionResponse)((yield* request("/api/session", {})).body)
    const omitted = yield* request(session(other.data.id), { delivery: "queue" })
    expect(omitted.status).toBe(200)
    expect(Schema.decodeUnknownSync(CompactResponse)(omitted.body).data.payload).toEqual({})
  }).pipe(Effect.scoped),
)

it.live("rejects an unknown compaction reason", () =>
  Effect.gen(function* () {
    const request = yield* makeRequest()
    const created = Schema.decodeUnknownSync(SessionResponse)((yield* request("/api/session", {})).body)

    const rejected = yield* request(`/api/session/${created.data.id}/compact`, { reason: "overflow" })
    expect(rejected.status).toBe(400)
  }).pipe(Effect.scoped),
)
