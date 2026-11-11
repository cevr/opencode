import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("reads the pending forms and permissions of a session and every session under it at once", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return { status: response.status, body: await response.json() }
      })
    const create = (input: unknown) =>
      request("/api/session", input).pipe(Effect.map((response) => (response.body as { data: { id: string } }).data.id))

    const directory = yield* tmpdirScoped()
    const root = yield* create({ location: { directory: directory.path } })
    const child = yield* create({ parentID: root })
    const grandchild = yield* create({ parentID: child })
    const other = yield* create({ location: { directory: directory.path } })
    const form = yield* request(`/api/session/${grandchild}/form`, {
      title: "Pick one",
      fields: [{ key: "answer", type: "string" }],
    })
    expect(form.status).toBe(200)
    yield* request(`/api/session/${other}/form`, { title: "Elsewhere", fields: [{ key: "answer", type: "string" }] })

    const family = yield* request(`/api/session/${root}/family/request`)
    expect(family.status).toBe(200)
    const data = (family.body as { data: { sessions: string[]; permissions: unknown[]; forms: unknown[] } }).data
    expect(data.sessions.toSorted()).toEqual([root, child, grandchild].toSorted())
    expect(data.permissions).toEqual([])
    expect(data.forms).toEqual([(form.body as { data: unknown }).data])

    expect((yield* request(`/api/session/ses_missing/family/request`)).status).toBe(404)
  }).pipe(Effect.scoped),
)
