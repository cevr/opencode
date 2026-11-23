// Seams: the public Promise SDK and plugin hooks (`experimental.model.resolve`, `http.request`) driving the real
// runner against two loopback OpenAI-compatible providers. Each assertion reads what reached the wire, the
// Session's durable record and the transcript; no provider, account or credential outside the test.
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { SessionModelResolve, SessionRouteStep } from "@opencode/plugin/promise/session"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { OpenCode } from "../src"

const ref = (providerID: string, id: string) =>
  Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(id) })
const ALPHA = ref("alpha", "alpha-model")
const BETA = ref("beta", "beta-model")
const GONE = ref("alpha", "alpha-retired")

interface Sent {
  readonly provider: string
  readonly model: string
  readonly session: string | null
  readonly tools: ReadonlyArray<string>
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
}
type Answer =
  | { readonly text: string }
  | { readonly tool: string; readonly input: Record<string, unknown> }
  | { readonly status: number }
const say = (text: string): Answer => ({ text })

interface Policy {
  resolve?: (event: SessionModelResolve) => void
  send?: (event: { step?: SessionRouteStep; model: { providerID: string; id: string }; refuse?: unknown }) => void
  retryNow?: boolean
}

const model = {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  limit: { context: 128_000, output: 16_000 },
}

const start = async (policy: Policy, answer: (sent: Sent, index: number) => Answer, data?: string) => {
  const sends: Sent[] = []
  const resolves: Array<{ kind: string; origin: string; available: boolean; model: string; step?: SessionRouteStep }> =
    []
  const marks: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (!path.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = await request.json()
      if (request.headers.get("x-route-kind") !== "primary") return sse(body.model, { text: "auxiliary" }, "aux")
      const sent: Sent = {
        provider: path.split("/")[1]!,
        model: body.model,
        session: request.headers.get("x-opencode-session-id"),
        tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
        messages: body.messages,
      }
      sends.push(sent)
      const result = answer(sent, sends.length - 1)
      if ("status" in result)
        return new Response(JSON.stringify({ error: { message: "synthetic" } }), { status: result.status })
      return sse(body.model, result, String(sends.length))
    },
  })
  const provider = (name: string, models: Record<string, object>) => ({
    name,
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${server.port}/${name}`, apiKey: "synthetic-only" },
    models,
  })
  const plugin: Plugin.Plugin = {
    id: "test.request-route",
    async setup(ctx) {
      await ctx.tool.transform((editor) =>
        editor.add({
          name: "mark",
          description: "Records one mark",
          input: {
            type: "object",
            properties: { note: { type: "string" } },
            required: ["note"],
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: async (input) => {
            marks.push(JSON.stringify(input))
            return { content: "marked" }
          },
        }),
      )
      await ctx.session.hook("title", (event) => {
        event.result = "Route test"
      })
      await ctx.session.hook("experimental.model.resolve", (event) => {
        resolves.push({
          kind: event.kind,
          origin: event.origin,
          available: event.available,
          model: `${event.model.providerID}/${event.model.id}`,
          ...(event.step ? { step: event.step } : {}),
        })
        policy.resolve?.(event)
      })
      await ctx.session.hook("http.request", (event) => {
        event.request.headers.set("x-route-kind", event.kind)
        policy.send?.(event)
      })
      if (policy.retryNow)
        await ctx.session.hook("retry", (event) => {
          if (event.decision.retry) event.decision = { retry: true, delay: 0 }
        })
    },
  }
  const directory = data ?? (await tmpdir("opencode-request-route-")).path
  const config = join(directory, "config")
  const work = join(directory, "work")
  await mkdir(config, { recursive: true })
  await mkdir(work, { recursive: true })
  const host = await OpenCode.create({
    events: { persist: true },
    database: { path: join(directory, "opencode.db") },
    models: { fetch: false },
    plugins: [plugin],
    config: {
      directory: config,
      project: false,
      content: JSON.stringify({
        model: `${ALPHA.providerID}/${ALPHA.id}`,
        enabled_providers: ["alpha", "beta"],
        providers: {
          alpha: provider("alpha", { [ALPHA.id]: model }),
          beta: provider("beta", { [BETA.id]: model }),
        },
        permissions: { "*": "allow" },
      }),
    },
  })
  return {
    host,
    work,
    directory,
    sends,
    resolves,
    marks,
    close: async () => {
      try {
        await host.close()
      } finally {
        await server.stop(true)
      }
    },
  }
}

const sse = (model: string, result: Answer, id: string) => {
  const meta = { id: `fixture_${id}`, object: "chat.completion.chunk", created: 1, model }
  const line = (item: unknown) => `data: ${JSON.stringify(item)}\n\n`
  const chunk = (delta: object, finish_reason?: string) =>
    line({ ...meta, choices: [{ index: 0, delta, finish_reason }] })
  const call = "tool" in result
  const delta = call
    ? {
        tool_calls: [
          {
            id: `call_${id}`,
            index: 0,
            type: "function",
            function: { name: result.tool, arguments: JSON.stringify(result.input) },
          },
        ],
      }
    : { content: "text" in result ? result.text : "" }
  const usage = line({ ...meta, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
  return new Response(
    chunk({ role: "assistant", content: "" }) +
      chunk(delta) +
      chunk({}, call ? "tool_calls" : "stop") +
      usage +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

const users = (sent: Sent, text: string) =>
  sent.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes(text)).length
const settle = (f: Awaited<ReturnType<typeof start>>, sessionID: string, ms = 5_000) =>
  f.host.experimental.session.wait({ sessionID }, { signal: AbortSignal.timeout(ms) })

test("an automatic primary request routes to another provider without changing the selection", async () => {
  const f = await start(
    {
      resolve: (event) => {
        if (event.kind === "primary" && event.origin !== "explicit") event.model = BETA
      },
    },
    () => say("done"),
  )
  try {
    const session = await f.host.session.create({ location: { directory: f.work } })
    await f.host.session.prompt({ sessionID: session.id, text: "route me" })
    await settle(f, session.id)
    expect(f.sends.map((sent) => [sent.provider, sent.model])).toEqual([["beta", BETA.id]])
    expect(users(f.sends[0]!, "route me")).toBe(1)
    expect(f.sends[0]!.tools).toContain("mark")
    const primary = f.resolves.filter((entry) => entry.kind === "primary")
    expect(primary[0]).toMatchObject({ origin: "fallback", available: true, model: "alpha/alpha-model" })
    expect(primary[0]!.step).toMatchObject({ attempt: 1 })
    const after = await f.host.session.get({ sessionID: session.id })
    expect(after.model).toBeUndefined()
    expect(after.outcome).toBe("succeeded")
  } finally {
    await f.close()
  }
}, 20_000)

test("an explicit selection is reported as explicit; a client default and an unavailable one are told apart", async () => {
  const f = await start(
    {
      // The test policy rescues an unavailable selection only when it was not a pick.
      resolve: (event) => {
        if (event.kind === "primary" && !event.available && event.origin === "default") event.model = BETA
      },
    },
    () => say("done"),
  )
  try {
    const managed = await f.host.session.create({
      location: { directory: f.work },
      model: GONE,
      modelOrigin: "default",
    })
    await f.host.session.prompt({ sessionID: managed.id, text: "managed" })
    await settle(f, managed.id)
    const explicit = await f.host.session.create({ location: { directory: f.work }, model: GONE })
    await f.host.session.prompt({ sessionID: explicit.id, text: "explicit" })
    await settle(f, explicit.id).catch(() => {})

    expect(f.sends.map((sent) => [sent.session, sent.provider])).toEqual([[managed.id, "beta"]])
    expect((await f.host.session.get({ sessionID: managed.id })).model).toMatchObject(GONE)
    expect((await f.host.session.get({ sessionID: managed.id })).modelOrigin).toBe("default")
    expect((await f.host.session.get({ sessionID: explicit.id })).modelOrigin).toBeUndefined()
    expect((await f.host.session.get({ sessionID: explicit.id })).outcome).toBe("failed")
    const primary = f.resolves.filter((entry) => entry.kind === "primary")
    expect(primary.map((entry) => [entry.origin, entry.available])).toEqual([
      ["default", false],
      ["explicit", false],
    ])

    // Picking the same model the client had recorded as its default records the pick.
    await f.host.session.switchModel({ sessionID: managed.id, model: GONE })
    expect((await f.host.session.get({ sessionID: managed.id })).modelOrigin).toBeUndefined()
    await f.host.session.switchModel({ sessionID: managed.id, model: ALPHA, origin: "default" })
    expect((await f.host.session.get({ sessionID: managed.id })).modelOrigin).toBe("default")
  } finally {
    await f.close()
  }
}, 20_000)

test("a routing hold waits without sending or failing, then sends the original prompt once", async () => {
  const f = await start(
    {
      resolve: (event) => {
        if (event.kind === "primary" && event.step?.attempt === 1)
          event.defer = { reason: "capacity held", until: Date.now() + 1_200 }
      },
    },
    () => say("done"),
  )
  try {
    const session = await f.host.session.create({ location: { directory: f.work } })
    await f.host.session.prompt({ sessionID: session.id, text: "hold me" })
    await Bun.sleep(600)
    expect(f.sends).toEqual([])
    const held = await f.host.message.list({ sessionID: session.id, limit: 20 })
    expect(JSON.stringify(held)).toContain("capacity held")
    expect((await f.host.session.get({ sessionID: session.id })).outcome).not.toBe("failed")
    await settle(f, session.id)
    expect(f.sends.map((sent) => sent.provider)).toEqual(["alpha"])
    expect(users(f.sends[0]!, "hold me")).toBe(1)
    const steps = f.resolves.filter((entry) => entry.kind === "primary").map((entry) => entry.step!)
    expect(steps.map((step) => step.attempt)).toEqual([1, 2])
    expect(new Set(steps.map((step) => step.id)).size).toBe(1)
    expect((await f.host.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
  } finally {
    await f.close()
  }
}, 20_000)

test("a refused send is never sent and re-enters routing for the same step", async () => {
  const f = await start(
    {
      resolve: (event) => {
        if (event.kind === "primary" && event.step?.previous && !event.step.previous.sent) event.model = BETA
      },
      send: (event) => {
        if (event.step && event.model.providerID === "alpha") event.refuse = { reason: "alpha closed at dispatch" }
      },
    },
    () => say("done"),
  )
  try {
    const session = await f.host.session.create({ location: { directory: f.work } })
    await f.host.session.prompt({ sessionID: session.id, text: "dispatch me" })
    await settle(f, session.id)
    expect(f.sends.map((sent) => sent.provider)).toEqual(["beta"])
    expect(users(f.sends[0]!, "dispatch me")).toBe(1)
    const steps = f.resolves.filter((entry) => entry.kind === "primary").map((entry) => entry.step!)
    expect(steps.map((step) => [step.attempt, step.previous?.sent])).toEqual([
      [1, undefined],
      [2, false],
    ])
    expect((await f.host.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
  } finally {
    await f.close()
  }
}, 20_000)

test("a throwing send hook still fails the execution and moves nothing", async () => {
  const f = await start(
    {
      resolve: (event) => {
        if (event.kind === "primary" && event.step?.previous) event.model = BETA
      },
      send: (event) => {
        if (event.step) throw new Error("ordinary plugin defect")
      },
    },
    () => say("done"),
  )
  try {
    const session = await f.host.session.create({ location: { directory: f.work } })
    await f.host.session.prompt({ sessionID: session.id, text: "defect" })
    await settle(f, session.id).catch(() => {})
    expect(f.sends).toEqual([])
    expect(f.resolves.filter((entry) => entry.kind === "primary" && entry.step?.previous)).toEqual([])
    expect((await f.host.session.get({ sessionID: session.id })).outcome).toBe("failed")
  } finally {
    await f.close()
  }
}, 20_000)

test("after a completed tool call the next step moves providers with the tool result and runs the tool once", async () => {
  let served = 0
  const f = await start(
    {
      resolve: (event) => {
        if (event.kind === "primary" && event.step?.previous && !event.step.previous.sent) event.model = BETA
      },
      // Alpha serves the first step, then closes.
      send: (event) => {
        if (event.step && event.model.providerID === "alpha" && served > 0)
          event.refuse = { reason: "alpha closed mid-turn" }
      },
    },
    (_sent, index) => {
      served++
      return index === 0 ? { tool: "mark", input: { note: "once" } } : say("finished")
    },
  )
  try {
    const session = await f.host.session.create({ location: { directory: f.work } })
    await f.host.session.prompt({ sessionID: session.id, text: "use the tool" })
    await settle(f, session.id)
    expect(f.sends.map((sent) => sent.provider)).toEqual(["alpha", "beta"])
    expect(f.marks).toEqual([JSON.stringify({ note: "once" })])
    expect(f.sends[1]!.messages.some((message) => message.role === "tool")).toBe(true)
    expect(users(f.sends[1]!, "use the tool")).toBe(1)
    const steps = f.resolves.filter((entry) => entry.kind === "primary").map((entry) => entry.step!)
    expect(new Set(steps.map((step) => step.id)).size).toBe(2)
    expect((await f.host.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
  } finally {
    await f.close()
  }
}, 20_000)

test("a retry after an attempt that reached the provider stays on that provider", async () => {
  const f = await start(
    {
      retryNow: true,
      resolve: (event) => {
        if (event.kind === "primary" && event.step?.previous) event.model = BETA
      },
    },
    (_sent, index) => (index === 0 ? { status: 500 } : say("recovered")),
  )
  try {
    const session = await f.host.session.create({ location: { directory: f.work } })
    await f.host.session.prompt({ sessionID: session.id, text: "flaky" })
    await settle(f, session.id)
    expect(f.sends.map((sent) => sent.provider)).toEqual(["alpha", "alpha"])
    const steps = f.resolves.filter((entry) => entry.kind === "primary").map((entry) => entry.step!)
    expect(steps.map((step) => step.previous?.sent)).toEqual([undefined, true])
    expect((await f.host.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
  } finally {
    await f.close()
  }
}, 20_000)

test("a cancel during a hold wins: nothing is sent afterwards", async () => {
  const f = await start(
    {
      resolve: (event) => {
        if (event.kind === "primary") event.defer = { reason: "held long", until: Date.now() + 60_000 }
      },
    },
    () => say("never"),
  )
  try {
    const session = await f.host.session.create({ location: { directory: f.work } })
    await f.host.session.prompt({ sessionID: session.id, text: "cancel me" })
    await Bun.sleep(300)
    await f.host.session.interrupt({ sessionID: session.id })
    await settle(f, session.id)
    await Bun.sleep(1_300)
    expect(f.sends).toEqual([])
    expect((await f.host.session.get({ sessionID: session.id })).outcome).toBe("interrupted")
  } finally {
    await f.close()
  }
}, 20_000)

test("a step held across a restart is delivered once by the next host", async () => {
  const shared = (await tmpdir("opencode-request-route-restart-")).path
  const first = await start(
    {
      resolve: (event) => {
        if (event.kind === "primary") event.defer = { reason: "held over restart", until: Date.now() + 60_000 }
      },
    },
    () => say("never"),
    shared,
  )
  const session = await first.host.session.create({ location: { directory: first.work } })
  try {
    await first.host.session.prompt({ sessionID: session.id, text: "survive restart" })
    await Bun.sleep(500)
    expect(first.sends).toEqual([])
  } finally {
    await first.close()
  }
  const second = await start({}, () => say("after restart"), shared)
  try {
    const end = Date.now() + 8_000
    while (second.sends.length === 0 && Date.now() < end) await Bun.sleep(50)
    await settle(second, session.id)
    expect(second.sends.map((sent) => [sent.session, sent.provider])).toEqual([[session.id, "alpha"]])
    expect(users(second.sends[0]!, "survive restart")).toBe(1)
    const transcript = JSON.stringify(await second.host.message.list({ sessionID: session.id, limit: 30 }))
    expect(transcript.split("survive restart").length - 1).toBe(1)
  } finally {
    await second.close()
  }
}, 30_000)

// A bounded model of one Step's routing: every sequence of up to two holds or refusals, then a send or a cancel.
// The model says what the host must do; the run drives the real runner through the same decisions.
type Decision = "defer" | "refuse"
const sequences = (length: number): Decision[][] =>
  length === 0
    ? [[]]
    : sequences(length - 1).flatMap((prefix) => [
        [...prefix, "defer" as const],
        [...prefix, "refuse" as const],
      ])
const cases = [0, 1, 2]
  .flatMap(sequences)
  .flatMap((prefix) => [
    { prefix, end: "send" as const },
    ...(prefix.length === 1 ? [{ prefix, end: "cancel" as const }] : []),
  ])

const expectRoute = (prefix: Decision[], end: "send" | "cancel") => {
  // Holds: a defer always waits; a refusal waits only right after an immediate re-route.
  let immediate = false
  let holds = 0
  for (const decision of prefix) {
    if (decision === "defer" || immediate) {
      holds++
      immediate = false
    } else immediate = true
  }
  return {
    sends: end === "send" ? 1 : 0,
    attempts: end === "send" ? prefix.length + 1 : prefix.length,
    outcome: end === "send" ? ("succeeded" as const) : ("interrupted" as const),
    holds,
  }
}

for (const { prefix, end } of cases) {
  test(`step routing [${[...prefix, end].join(" > ")}] matches the model`, async () => {
    const expected = expectRoute(prefix, end)
    const attempt = (step: SessionRouteStep | undefined) => (step ? prefix[step.attempt - 1] : undefined)
    const held = end === "cancel" ? prefix.length : Infinity
    const f = await start(
      {
        resolve: (event) => {
          if (event.kind !== "primary") return
          if (event.step && event.step.attempt > held)
            event.defer = { reason: "held for cancel", until: Date.now() + 60_000 }
          else if (attempt(event.step) === "defer") event.defer = { reason: "model hold", until: 0 }
        },
        send: (event) => {
          if (attempt(event.step) === "refuse") event.refuse = { reason: "model refusal" }
        },
      },
      () => say("done"),
    )
    try {
      const session = await f.host.session.create({ location: { directory: f.work } })
      const started = Date.now()
      await f.host.session.prompt({ sessionID: session.id, text: "modelled prompt" })
      if (end === "cancel") {
        const until = Date.now() + 5_000
        while (f.resolves.filter((entry) => entry.kind === "primary").length <= prefix.length && Date.now() < until)
          await Bun.sleep(20)
        await f.host.session.interrupt({ sessionID: session.id })
      }
      await settle(f, session.id, 10_000)
      // Each hold waits at least a second, so no decision sequence spins.
      if (end === "send") expect(Date.now() - started).toBeGreaterThanOrEqual(expected.holds * 1_000 - 50)
      const steps = f.resolves.filter((entry) => entry.kind === "primary").map((entry) => entry.step!)
      expect(f.sends.length).toBe(expected.sends)
      if (expected.sends) expect(users(f.sends[0]!, "modelled prompt")).toBe(1)
      expect(steps.slice(0, expected.attempts).map((step) => step.attempt)).toEqual(
        Array.from({ length: expected.attempts }, (_, index) => index + 1),
      )
      expect(new Set(steps.map((step) => step.id)).size).toBe(1)
      expect(steps.every((step) => step.previous?.sent !== true)).toBe(true)
      expect((await f.host.session.get({ sessionID: session.id })).outcome).toBe(expected.outcome)
    } finally {
      await f.close()
    }
  }, 20_000)
}
