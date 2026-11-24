// Fork feature (synthetic-archived): what a command's agent and model selection writes, and in which order, for four
// shapes: select to plan and prompt, select from plan and prompt, select a model only and prompt, select with no
// prompt. The messages must be upstream's, in upstream's order (plan.ts's reminder before the user's prompt). Only
// upstream modules are imported (and the fixture, which imports only upstream's), so this file runs unchanged at the
// base to measure upstream's sequences.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { commandLayer, project, sequence } from "../fixture/command-selection"
import { testEffect } from "../lib/effect"

const it = testEffect(commandLayer())

describe("a command's selection writes upstream's messages in upstream's order", () => {
  it.live("to plan, then its prompt", () =>
    Effect.gen(function* () {
      const session = yield* project()
      expect(yield* sequence(session.id, "pick")).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "user",
        "assistant",
        "idle",
      ])
    }),
  )

  it.live("from plan, then its prompt", () =>
    Effect.gen(function* () {
      const session = yield* project("plan")
      expect(yield* sequence(session.id, "leave")).toEqual(["agent-switched", "synthetic", "user", "assistant", "idle"])
    }),
  )

  it.live("a model only, then its prompt", () =>
    Effect.gen(function* () {
      const session = yield* project()
      expect(yield* sequence(session.id, "m2")).toEqual(["model-switched", "user", "assistant", "idle"])
    }),
  )

  it.live("with no prompt", () =>
    Effect.gen(function* () {
      const session = yield* project()
      expect(yield* sequence(session.id, "select")).toEqual(["agent-switched", "model-switched"])
      // The reminder waits in the inbox for the next turn.
      const sessions = yield* Session.Service
      expect((yield* sessions.inbox(session.id)).map((item) => item.type)).toEqual(["synthetic"])
    }),
  )
})

describe("a command keeps its model choice and origin together", () => {
  it.live("a config command explicitly picks the same model the client had set as a default", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      const model = Model.Ref.make({ id: Model.ID.make("m2"), providerID: Provider.ID.make("test") })
      yield* sessions.switchModel({ sessionID: session.id, model, origin: "default" })
      expect(yield* sequence(session.id, "m2")).toEqual(["model-switched", "user", "assistant", "idle"])
      const selected = yield* sessions.get(session.id)
      expect(selected.model).toEqual({ ...model, variant: Model.VariantID.make("default") })
      expect(selected.modelOrigin).toBeUndefined()
    }),
  )

  it.live("a plugin reads the last choice inside its command and keeps its origin when the command returns", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      yield* sessions.command({ sessionID: session.id, command: "choose-default", text: "" })
      const selected = yield* sessions.get(session.id)
      expect(selected.model?.id).toBe(Model.ID.make("m2"))
      expect(selected.modelOrigin).toBe("default")
    }),
  )
})
