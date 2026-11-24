// A routing test's world: one loopback server for two OpenAI-compatible providers and one database, outliving every
// host a test opens on them, as a restart would. Plugin hooks record each primary resolution and refusal; the server
// records each primary request that reached the wire, when, and on which provider. No provider, account or
// credential outside the test.
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { SessionModelResolve, SessionRouteStep } from "@opencode/plugin/promise/session"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { tmpdir } from "../../../core/test/fixture/tmpdir"
import { OpenCode } from "../../src"

const ref = (providerID: string, id: string) =>
  Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(id) })
export const ALPHA = ref("alpha", "alpha-model")
export const BETA = ref("beta", "beta-model")
/** The native notice a restart adds to a turn it resumes mid-work. */
export const RESTART_NOTICE = "The server restarted"

export type Host = Awaited<ReturnType<typeof OpenCode.create>>

export interface Sent {
  readonly at: number
  readonly provider: string
  readonly session: string | null
  readonly body: string
}
export type Answer =
  | { readonly text: string }
  | { readonly status: number }
  | { readonly tool: string; readonly input: object }
  /** The request reached the provider, which starts its answer and never finishes it: the attempt is in flight. */
  | { readonly hang: true }

export interface Policy {
  resolve?: (event: SessionModelResolve) => void
  send?: (event: { step?: SessionRouteStep; model: { providerID: string; id: string }; refuse?: unknown }) => void
}

const model = {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  limit: { context: 128_000, output: 16_000 },
}

export const fixture = async (policy: Policy, answer: (sent: Sent, index: number) => Answer) => {
  const sends: Sent[] = []
  const resolves: Array<{ at: number; session: string; step: SessionRouteStep; model: string }> = []
  const refusals: Array<{ at: number; step: SessionRouteStep }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (!path.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = await request.json()
      if (request.headers.get("x-route-kind") !== "primary") return sse(body.model, { text: "auxiliary" }, "aux")
      const sent: Sent = {
        at: Date.now(),
        provider: path.split("/")[1]!,
        session: request.headers.get("x-opencode-session-id"),
        body: JSON.stringify(body.messages),
      }
      sends.push(sent)
      const result = answer(sent, sends.length - 1)
      if ("status" in result)
        return new Response(JSON.stringify({ error: { message: "synthetic" } }), { status: result.status })
      if ("hang" in result) return hang(body.model, String(sends.length))
      return sse(body.model, result, String(sends.length))
    },
  })
  const directory = (await tmpdir("opencode-request-route-host-")).path
  const config = join(directory, "config")
  const work = join(directory, "work")
  await mkdir(config, { recursive: true })
  await mkdir(work, { recursive: true })
  const provider = (name: string, models: Record<string, object>) => ({
    name,
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${server.port}/${name}`, apiKey: "synthetic-only" },
    models,
  })
  const plugin: Plugin.Plugin = {
    id: "test.request-route-host",
    async setup(ctx) {
      await ctx.session.hook("title", (event) => {
        event.result = "Route test"
      })
      await ctx.session.hook("experimental.model.resolve", (event) => {
        if (event.kind !== "primary" || !event.step) return
        resolves.push({
          at: Date.now(),
          session: event.sessionID,
          step: event.step,
          model: `${event.model.providerID}/${event.model.id}`,
        })
        policy.resolve?.(event)
      })
      await ctx.session.hook("http.request", (event) => {
        event.request.headers.set("x-route-kind", event.kind)
        policy.send?.(event)
        if (event.refuse && event.step) refusals.push({ at: Date.now(), step: event.step })
      })
      // Ordinary provider failures retry at once, so a run spends its time only in holds.
      await ctx.session.hook("retry", (event) => {
        if (event.decision.retry) event.decision = { retry: true, delay: 0 }
      })
    },
  }
  const hosts: Host[] = []
  const open = async () => {
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
          providers: { alpha: provider("alpha", { [ALPHA.id]: model }), beta: provider("beta", { [BETA.id]: model }) },
          permissions: { "*": "allow" },
        }),
      },
    })
    hosts.push(host)
    return host
  }
  return {
    open,
    work,
    sends,
    resolves,
    refusals,
    async [Symbol.asyncDispose]() {
      try {
        for (const host of hosts.splice(0)) await host.close().catch(() => {})
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
  return new Response(
    chunk({ role: "assistant", content: "" }) +
      chunk(delta) +
      chunk({}, call ? "tool_calls" : "stop") +
      line({ ...meta, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

const hang = (model: string, id: string) => {
  const meta = { id: `fixture_${id}`, object: "chat.completion.chunk", created: 1, model }
  const first = `data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first))
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

/** How many times `text` appears in the messages of a request. */
export const count = (sent: Sent, text: string) => sent.body.split(text).length - 1

export const until = async (ready: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!ready() && Date.now() < end) await Bun.sleep(20)
  return ready()
}

export const settle = (host: Host, sessionID: string, ms = 8_000) =>
  host.experimental.session.wait({ sessionID }, { signal: AbortSignal.timeout(ms) })
