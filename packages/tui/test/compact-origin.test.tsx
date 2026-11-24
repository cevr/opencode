import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { Effect } from "effect"
import { join } from "node:path"
import { EmbeddedHost } from "../../sdk/src/internal/host"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"

test("/compact keeps the implicit model, while picking that same model records an explicit switch", async () => {
  await using config = await tmpdir()
  const host = await Effect.runPromise(
    EmbeddedHost.create({
      database: { path: join(config.path, "session.sqlite") },
      events: { persist: true },
      models: { fetch: false },
      instructions: { claude: false },
      config: {
        directory: config.path,
        project: false,
        claude: false,
        content: JSON.stringify({
          model: "demo/model",
          enabled_providers: ["demo"],
          providers: {
            demo: {
              name: "Demo",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: "https://provider.invalid/v1", apiKey: "fixture" },
              models: { model: { name: "Demo Model", limit: { context: 128_000, output: 16_000 } } },
            },
          },
        }),
      },
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.origin !== "https://provider.invalid" || !url.pathname.endsWith("/chat/completions"))
          return new Response(null, { status: 404 })
        const request = new Request(input, init)
        const text = (await request.text()).includes("## Objective") ? "## Objective\nRemember this." : "Fixture reply"
        const chunk = (delta: object, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: "test", model: "model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        return new Response(
          chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    }),
  )
  try {
    const sessionID = "ses_compact_origin"
    const client = OpenCode.make({ baseUrl: "http://opencode.local", fetch: host.fetch })
    await using app = await createAppFixture({
      args: { newSessionID: sessionID },
      fetch: (_url, request) => host.fetch(request),
    })
    const messages = async () => (await client.message.list({ sessionID })).data
    const send = async (text: string) => {
      await app.mockInput.typeText(text)
      app.mockInput.pressEnter()
    }

    await app.ready
    await app.waitForFrame((frame) => frame.includes("Demo Model"))
    await send("Remember this")
    await app.waitForFrame((frame) => frame.includes("Fixture reply"))
    await client.session.wait({ sessionID })
    const beforeCompact = await client.session.get({ sessionID })
    expect(beforeCompact.modelOrigin).toBe("default")

    await send("/compact")
    await app.waitFor(
      async () => (await messages()).some((item) => item.type === "compaction" && item.status !== "running"),
      { maxPasses: 100 },
    )
    const afterCompact = await client.session.get({ sessionID })
    expect((await messages()).find((item) => item.type === "compaction")).toMatchObject({ status: "completed" })
    expect({
      model: afterCompact.model,
      origin: afterCompact.modelOrigin,
      switches: (await messages()).filter((item) => item.type === "model-switched"),
    }).toEqual({ model: beforeCompact.model, origin: "default", switches: [] })

    await send("/models")
    await app.waitForFrame(
      (frame) => frame.includes("Select model") && app.renderer.currentFocusedRenderable instanceof InputRenderable,
    )
    await app.mockInput.typeText("Demo Model")
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.waitForFrame(
      (frame) => frame.includes("Select variant") && app.renderer.currentFocusedRenderable instanceof InputRenderable,
    )
    app.mockInput.pressEnter()
    await app.waitForFrame(
      (frame) => !frame.includes("Select variant") && app.renderer.currentFocusedRenderable instanceof TextareaRenderable,
    )
    await send("Keep going")
    await app.waitFor(async () => (await messages()).some((item) => item.type === "model-switched"), { maxPasses: 100 })
    await client.session.wait({ sessionID })
    const afterPick = await client.session.get({ sessionID })
    expect(afterPick.modelOrigin ?? "explicit").toBe("explicit")
    expect(afterPick.model).toEqual(beforeCompact.model)
    expect(await app.waitForFrame((frame) => frame.includes("Switched variant to default"))).toContain(
      "Switched variant to default",
    )
  } finally {
    await host.close()
  }
}, 30_000)
