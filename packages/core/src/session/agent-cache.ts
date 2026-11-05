export * as SessionAgentCache from "./agent-cache.js"

import { Provider } from "@opencode/schema/provider"
import type { Agent } from "@opencode/schema/agent"
import { Schema } from "effect"
import type { SessionRunnerModel } from "./runner/model.js"

const isCacheTTL = Schema.is(Provider.CacheTTL)

/**
 * The model as an agent runs it: with the agent's own prompt-cache lifetime when a plugin set one as
 * `request.settings.cacheTTL` (for example "5m"), so agents that share a model keep their caches for different
 * lengths, as `request.settings.compactionWindow` gives them their own compaction size. It only replaces a lifetime
 * the provider already configures: a model with none keeps its provider's default, so a lifetime meant for one
 * provider never reaches another's cache options. A value that is no lifetime changes nothing.
 */
export const apply = (model: SessionRunnerModel.Resolved, agent: Agent.Info): SessionRunnerModel.Resolved => {
  const ttl = agent.request?.settings?.["cacheTTL"]
  if (model.cache?.ttl === undefined || typeof ttl !== "string" || !isCacheTTL(ttl)) return model
  return { ...model, cache: { ...model.cache, ttl } }
}
