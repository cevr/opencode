import { describe, expect, test } from "bun:test"
import { LanguageModel } from "@opencode/ai/effect"
import { AnthropicMessages } from "@opencode/ai/protocols"
import type { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { SessionAgentCache } from "@opencode/core/session/agent-cache"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"

const base = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "claude-opus-5-5", provider: "anthropic", route: AnthropicMessages.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [
      {
        input: Money.USDPerMillionTokens.make(1),
        output: Money.USDPerMillionTokens.make(2),
        cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
      },
    ],
    limit: { context: 200_000, output: 32_000 },
  },
)
const configured = { ...base, cache: { ttl: "1h" as const } }
const agent = (settings: Record<string, unknown>) => ({ request: { settings, headers: {}, body: {} } }) as unknown as Agent.Info

describe("an agent's own prompt-cache lifetime", () => {
  test("replaces the provider's configured lifetime", () => {
    expect(SessionAgentCache.apply(configured, agent({ cacheTTL: "5m" })).cache).toEqual({ ttl: "5m" })
  })

  test("an agent without one keeps the provider's", () => {
    expect(SessionAgentCache.apply(configured, agent({ compactionWindow: 200_000 }))).toBe(configured)
  })

  test("a model whose provider configures none keeps the provider default", () => {
    expect(SessionAgentCache.apply(base, agent({ cacheTTL: "5m" }))).toBe(base)
  })

  test("a value that is no lifetime changes nothing", () => {
    for (const cacheTTL of ["soon", 5, "5 minutes"]) expect(SessionAgentCache.apply(configured, agent({ cacheTTL }))).toBe(configured)
  })
})
