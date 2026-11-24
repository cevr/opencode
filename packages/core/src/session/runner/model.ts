export * as SessionRunnerModel from "./model.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LanguageModel } from "@opencode/ai/effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Context, Effect, Layer, Schema } from "effect"
import type { SessionModelOrigin, SessionRequestKind, SessionRouteStep } from "@opencode/plugin/effect/session"
import { Agent } from "../../agent.js"
import { ModelResolver } from "../../model-resolver.js"
import { PluginHooks } from "../../plugin/hooks.js"
import { SessionSchema } from "../schema.js"

export class ModelNotSelectedError extends Schema.TaggedError<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  { sessionID: SessionSchema.ID },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedError<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  { providerID: Provider.ID, modelID: Model.ID },
) {
  override get message() {
    if (this.providerID === "azure-cognitive-services")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use azure/${this.modelID} instead.`
    if (this.providerID === "google-vertex-anthropic")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use google-vertex/${this.modelID} instead.`
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}
/** A routing hook held the runner's Step: nothing was built or sent for it. Never escapes the runner. */
export class RouteDeferred extends Schema.TaggedError<RouteDeferred>()("SessionRunnerModel.RouteDeferred", {
  model: Model.Ref,
  reason: Schema.String,
  until: Schema.Number,
}) {
  override get message() {
    return `Request held: ${this.reason}`
  }
}

export type Error = ModelNotSelectedError | ModelUnavailableError | ModelResolver.Error | RouteDeferred
export type Resolved = ModelResolver.Resolved

export interface Selected {
  /** The catalog entry, absent when the Session's stored selection is not offered here. */
  readonly info: Model.Info | undefined
  readonly ref: Model.Ref
  readonly variant: Model.VariantID | undefined
  readonly origin: SessionModelOrigin
}

export interface Request {
  readonly kind: SessionRequestKind
  readonly agent: Agent.ID
  /** The runner's durable Step, for its primary requests only. Allows `defer`. */
  readonly step?: SessionRouteStep
}

export interface Interface {
  /** The starting model of a resolution and where it came from; an unavailable stored selection has no `info`. */
  readonly select: (
    session: SessionSchema.Info,
    available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
  ) => Effect.Effect<Selected, ModelNotSelectedError>
  /** Availability is sampled lazily for each explicitly selected model resolution. */
  readonly resolve: (
    session: SessionSchema.Info,
    available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
    request: Request,
  ) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunnerModel") {}

/** Builds a Resolved whose catalog identity mirrors the route model. Test or embedding seam. */
export const resolved = (
  model: LanguageModel,
  options: {
    readonly capabilities: Model.Capabilities
    readonly variant?: Model.VariantID
    readonly cost: Model.Info["cost"]
    readonly limit: Model.Info["limit"]
    readonly compaction?: Provider.Compaction
    readonly transport?: Provider.Transport
  },
): Resolved => ({
  model,
  ref: Model.Ref.make({
    id: Model.ID.make(model.id),
    providerID: Provider.ID.make(model.provider),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  }),
  capabilities: options.capabilities,
  cost: options.cost,
  limit: options.limit,
  compaction: options.compaction,
  transport: options.transport,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const agents = yield* Agent.Service
    const hooks = yield* PluginHooks.Service
    // Location plugins populate and filter the catalog asynchronously during layer startup.
    const select = Effect.fn("SessionRunnerModel.select")(function* (
      session: SessionSchema.Info,
      available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
    ) {
      const find = (ref: Model.Ref) =>
        available().pipe(
          Effect.map((models) => models.find((model) => model.providerID === ref.providerID && model.id === ref.id)),
        )
      const ref = (info: Model.Info, variant: Model.VariantID | undefined) =>
        Model.Ref.make({ providerID: info.providerID, id: info.id, ...(variant === undefined ? {} : { variant }) })
      if (session.model)
        return {
          info: yield* find(session.model),
          ref: session.model,
          variant: session.model.variant,
          origin: session.modelOrigin ?? "explicit",
        } satisfies Selected
      const agent = (yield* agents.select(session.agent)).info?.model
      const preferred = agent && (yield* find(agent))
      if (preferred)
        return {
          info: preferred,
          ref: ref(preferred, agent.variant),
          variant: agent.variant,
          origin: "agent",
        } satisfies Selected
      const info = yield* resolver.fallback()
      if (info) return { info, ref: ref(info, undefined), variant: undefined, origin: "fallback" } satisfies Selected
      return yield* new ModelNotSelectedError({ sessionID: session.id })
    })
    return Service.of({
      select,
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session, available, request) {
        const selected = yield* select(session, available)
        const ref = selected.ref
        const event = yield* hooks.trigger("session", "experimental.model.resolve", {
          sessionID: session.id,
          agent: request.agent,
          kind: request.kind,
          origin: selected.origin,
          available: selected.info !== undefined,
          ...(request.step ? { step: request.step } : {}),
          model: ref,
        })
        if (request.step && event.defer)
          return yield* new RouteDeferred({ model: event.model, reason: event.defer.reason, until: event.defer.until })
        // An attempt that may have reached its provider retries there: an ambiguous send never moves providers.
        const previous = request.step?.previous
        const model =
          previous?.sent && event.model.providerID !== previous.model.providerID ? previous.model : event.model
        if (model !== event.model)
          yield* Effect.logWarning("route kept on the provider of an attempt that may have been sent", {
            sessionID: session.id,
            requested: event.model,
            kept: model,
          })
        if (model.providerID === ref.providerID && model.id === ref.id && model.variant === ref.variant) {
          if (selected.info) return yield* resolver.resolveModel(selected.info, selected.variant)
          return yield* new ModelUnavailableError({ providerID: ref.providerID, modelID: ref.id })
        }
        // The selection's provider may serve a model hidden from the picker. Another provider serves only a model it
        // offers here, with its own credentials and hooks, since the request is built for the model it resolves to.
        if (model.providerID === ref.providerID) {
          const resolved = yield* resolver.resolve(model)
          if (resolved) return resolved
        } else {
          const offered = (yield* available()).find(
            (item) => item.providerID === model.providerID && item.id === model.id,
          )
          if (offered) return yield* resolver.resolveModel(offered, model.variant)
        }
        return yield* new ModelUnavailableError({ providerID: model.providerID, modelID: model.id })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ModelResolver.node, Agent.node, PluginHooks.node],
})
