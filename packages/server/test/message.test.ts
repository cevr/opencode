import { expect } from "bun:test"
import { OpenCode, type SessionMessageInfo } from "@opencode/client"
import { SessionOutline } from "@opencode/core/session/outline"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const messages: SessionMessageInfo[] = [
  { id: "msg_z", type: "user", text: "First request", time: { created: 300 } },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [{ type: "text", text: "First answer" }],
    finish: "stop",
    time: { created: 400, completed: 500 },
  },
  { id: "msg_b", type: "user", text: "Second request", time: { created: 100 } },
  { id: "msg_synthetic", type: "synthetic", text: "Background completion", time: { created: 200 } },
  {
    id: "msg_compaction",
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "Conversation summary",
    time: { created: 700 },
  },
  { id: "msg_x", type: "user", text: "Third request", time: { created: 600 } },
  { id: "msg_system", type: "system", text: "Updated instructions", time: { created: 800 } },
  { id: "msg_a", type: "user", text: "Fourth request", time: { created: 500 } },
  { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 900 } },
]

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    config: { project: false },
    models: { fetch: false },
    fs: { filewatcher: false },
  })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })
  const session = yield* Effect.promise(async () => {
    const template = await api.session.create({ title: "Message filtering" })
    return api.experimental.session.import({ info: { ...template, id: Session.ID.create() }, messages })
  })
  return { api, handler, sessionID: session.id }
})

it.live("filters message types before paginating in either direction through the generated client", () =>
  Effect.gen(function* () {
    const fixture = yield* setup
    yield* Effect.promise(async () => {
      const input = { sessionID: fixture.sessionID, type: "user", limit: 2 } as const
      // Omission retains the full transcript, in durable sequence rather than timestamp or ID order.
      expect(
        (await fixture.api.message.list({ sessionID: fixture.sessionID })).data.map((message) => message.id),
      ).toEqual(messages.toReversed().map((message) => message.id))
      for (const order of ["asc", "desc"] as const) {
        const ids = order === "asc" ? ["msg_z", "msg_b", "msg_x", "msg_a"] : ["msg_a", "msg_x", "msg_b", "msg_z"]
        const first = await fixture.api.message.list({ ...input, order })
        expect(first.data.map((message) => message.id)).toEqual(ids.slice(0, 2))
        if (!first.cursor.next) throw new Error("Expected a next cursor")
        const second = await fixture.api.message.list({ ...input, cursor: first.cursor.next })
        expect(second.data.map((message) => message.id)).toEqual(ids.slice(2))
        if (!second.cursor.previous || !second.cursor.next) throw new Error("Expected previous and next cursors")
        const previous = await fixture.api.message.list({ ...input, cursor: second.cursor.previous })
        expect(previous.data).toEqual(first.data)
        const end = await fixture.api.message.list({ ...input, cursor: second.cursor.next })
        expect(end).toEqual({ data: [], cursor: { previous: null, next: null } })
      }
      expect((await fixture.api.message.list({ sessionID: fixture.sessionID, type: "compaction" })).data).toEqual([
        messages[4],
      ])
      expect(
        (await fixture.api.message.list({ sessionID: fixture.sessionID, type: "assistant", limit: 1 })).data,
      ).toEqual([messages[1]])
      expect((await fixture.api.message.list({ sessionID: fixture.sessionID, type: "idle" })).data).toEqual([
        messages[8],
      ])
      expect((await fixture.api.message.list({ sessionID: fixture.sessionID, type: "shell" })).data).toEqual([])
    })
  }),
)

it.live("rejects unknown message type filters at the HTTP boundary", () =>
  Effect.gen(function* () {
    const fixture = yield* setup
    yield* Effect.promise(async () => {
      for (const type of ["unknown", "tool", "User", ""]) {
        const response = await fixture.handler(
          new Request(`http://opencode.local/api/session/${fixture.sessionID}/message?type=${type}`),
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ _tag: "InvalidRequestError" })
      }
    })
  }),
)

it.live("outlines a session's messages without their bodies, and extends an outline read before", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      config: { project: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const api = OpenCode.make({
      baseUrl: "http://opencode.local",
      fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
        preconnect: fetch.preconnect,
      }),
    })
    const long = "x".repeat(5_000)
    const outlined: SessionMessageInfo[] = [
      { id: "msg_1", type: "user", text: `Ship it\n${long}`, time: { created: 100 } },
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "test" },
        content: [
          { type: "reasoning", text: "Thinking it over" },
          { type: "reasoning", text: " [REDACTED] " },
          {
            type: "tool",
            id: "call_1",
            name: "bash",
            state: { status: "completed", input: {}, content: [{ type: "text", text: long }] },
            time: { created: 210 },
          },
          { type: "text", text: "  " },
          { type: "text", text: "Shipped. The notes follow." },
          {
            type: "tool",
            id: "call_2",
            name: "read",
            state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] },
            time: { created: 220 },
          },
        ],
        finish: "stop",
        time: { created: 200, completed: 300 },
      },
      {
        id: "msg_3",
        type: "synthetic",
        text: long,
        description: "implementor fix r1",
        metadata: { source: "subagent" },
        time: { created: 400 },
      },
      { id: "msg_3s", type: "system", text: "Context changed\nThe rest", time: { created: 450 } },
      { id: "msg_4", type: "idle", outcome: "succeeded", time: { created: 500 } },
    ]
    yield* Effect.promise(async () => {
      const template = await api.session.create({ title: "Outline" })
      const session = await api.experimental.session.import({
        info: { ...template, id: Session.ID.create() },
        messages: outlined,
      })
      const outline = await api.message.outline({ sessionID: session.id })
      expect(outline).toEqual([
        { id: "msg_1", type: "user", time: 100, summary: "Ship it" },
        {
          id: "msg_2",
          type: "assistant",
          time: 200,
          completed: 300,
          summary: "Shipped.",
          tools: 2,
          thoughts: 1,
        },
        {
          id: "msg_3",
          type: "synthetic",
          time: 400,
          summary: "Subagent finished · implementor fix r1",
          source: "subagent",
        },
        { id: "msg_3s", type: "system", time: 450, summary: "Context changed" },
        { id: "msg_4", type: "idle", time: 500 },
      ])
      expect(await api.message.outline({ sessionID: session.id, after: "msg_2" })).toEqual(outline.slice(2))
      // A page back from a message: the newest ones before it, still oldest first; with no `before`, the newest.
      expect(await api.message.outline({ sessionID: session.id, before: "msg_4", limit: 2 })).toEqual(
        outline.slice(2, 4),
      )
      expect(await api.message.outline({ sessionID: session.id, limit: 1 })).toEqual(outline.slice(4))
      expect(await api.message.outline({ sessionID: session.id, before: "msg_2" })).toEqual(outline.slice(0, 1))
      expect(await api.message.outline({ sessionID: session.id, before: "msg_1", limit: 5 })).toEqual([])
      // A client folds the messages it already holds into the very entries the server reads.
      const held = await api.message.list({ sessionID: session.id, order: "asc" })
      expect(held.data.map((message) => SessionOutline.entry(message))).toEqual(outline)
      const unknown = await handler(
        new Request(`http://opencode.local/api/session/${session.id}/outline?after=msg_gone`),
      )
      expect(unknown.status).toBe(400)
    })
  }),
)
