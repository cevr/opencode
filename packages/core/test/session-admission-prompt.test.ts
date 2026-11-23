// Fork feature (synthetic-archived): a plugin's Session.prompt into a session with a staged revert. The revert's commit
// and the prompt's admission are one transaction: refused, the call changes nothing (the session's rows are
// byte-identical to before it); admitted, both commit and the wake is rung after. The archive lands while the prompt is
// prepared (after its early check), so only the in-transaction decision can refuse it.
import { describe, expect } from "bun:test"
import type { FileSystem } from "@opencode/core/filesystem"
import { Cause, DateTime, Effect, Exit, Layer, LayerMap, Schema } from "effect"
import { Database } from "@opencode/core/database/database"
import { Agent } from "@opencode/core/agent"
import { App } from "@opencode/core/app"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/schema/location"
import { SessionEvent } from "@opencode/core/session/event"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionAdmission } from "@opencode/core/session/admission"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Snapshot } from "@opencode/core/snapshot"
import { Skill } from "@opencode/core/skill"
import { Config } from "@opencode/core/config"
import { Flag } from "@opencode/core/flag"
import { testEffect } from "./lib/effect"
import { dump } from "./fixture/admission-model"

const wakes: Session.ID[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    wake: (sessionID) => Effect.sync(() => void wakes.push(sessionID)),
    awaitIdle: () => Effect.void,
    stop: () => Effect.succeed(false),
    stopped: () => Effect.succeed(false),
    recover: () => Effect.void,
  }),
)

/** Runs while the prompt is prepared (Plugin.awaitActivation), after its early check and before its transaction. */
const preparing: { run: Effect.Effect<void> } = { run: Effect.void }

const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const app = yield* App.Service
      const bus = yield* Bus.Service
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only what prompt preparation uses
          Layer.mergeAll(
            LayerNode.compile(LayerNode.group([App.node, Config.node, Flag.node, PluginHooks.node, Skill.node]), {
              replacements: [
                App.node.replace(Layer.succeed(App.Service, app)),
                Bus.node.replace(Layer.succeed(Bus.Service, bus)),
                Config.node.replace(Config.testLayer([])),
              ],
            }),
            Layer.mock(Snapshot.Service, { capture: () => Effect.undefined, restore: () => Effect.void }),
            Layer.mock(Plugin.Service, { awaitActivation: Effect.suspend(() => preparing.run) }),
          ).pipe(Layer.fresh) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      )
    }),
  ),
  deps: [App.node, Bus.node],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      SessionExecution.node.replace(execution),
      LocationServiceMap.node.replace(locations),
      App.node.replace(App.configured({})),
    ],
  ),
)

const encodeMessage = Schema.encodeSync(SessionMessage.Info)

/** A session whose last prompt (the boundary) has a later assistant message, and a revert staged to the boundary. */
const staged = Effect.fnUntraced(function* (id: string) {
  const sessionID = Session.ID.make(id)
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const sessions = yield* Session.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "t" })
    .run()
    .pipe(Effect.orDie)
  const boundary = yield* sessions.prompt({ sessionID, text: "boundary", resume: false })
  yield* SessionInbox.promote(db, bus, sessionID, "steer")
  const stale = SessionMessage.ID.make(`msg_${id}_stale`)
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({
      id: stale,
      type: "assistant",
      agent: Agent.ID.make("build"),
      model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
      content: [],
      time: { created: DateTime.makeUnsafe(0) },
    }),
  )
  yield* db
    .insert(SessionMessageTable)
    .values({ id: stale, session_id: sessionID, type, seq: 100, time_created: 0, data })
    .run()
    .pipe(Effect.orDie)
  yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID, revert: { messageID: boundary.id, files: [] } })
  expect((yield* sessions.get(sessionID)).revert?.messageID).toBe(boundary.id)
  return sessionID
})

describe("a plugin's prompt and a staged revert", () => {
  it.effect(
    "archived while the prompt is prepared: refused, and the call changed nothing (the revert stays staged)",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { db } = yield* Database.Service
        const sessionID = yield* staged("ses_prompt_revert_refused")
        const before = yield* dump(db, sessionID)
        wakes.length = 0
        // The owner archives while the plugin's prompt is prepared; the archive's own rows are the expected change.
        let archived = ""
        preparing.run = sessions.archive(sessionID).pipe(
          Effect.orDie,
          Effect.andThen(dump(db, sessionID)),
          Effect.map((rows) => void (archived = rows)),
        )
        const exit = yield* sessions
          .prompt({ sessionID, text: "a plugin's prompt", source: "plugin" })
          .pipe(Effect.exit)
        preparing.run = Effect.void
        expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as { _tag?: string })._tag).toBe(
          "SessionAdmission.Refused",
        )
        expect(archived).not.toBe(before)
        // Byte-identical to the moment before the call's own transaction: no revert commit, no row, no event.
        expect(yield* dump(db, sessionID)).toBe(archived)
        expect((yield* sessions.get(sessionID)).revert).toBeDefined()
        expect(wakes).toEqual([])
      }),
  )

  it.effect("live: the revert commits with the admission, and the wake is rung after", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const sessionID = yield* staged("ses_prompt_revert_live")
      wakes.length = 0
      const admitted = yield* sessions.prompt({ sessionID, text: "a plugin's prompt", source: "plugin" })
      expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
      expect(yield* SessionInbox.find(db, admitted.id)).toBeDefined()
      expect(yield* SessionAdmission.isHeld(db, admitted.id)).toBe(false)
      expect(wakes).toEqual([sessionID])
    }),
  )

  it.effect(
    "an HTTP prompt (held) archived while prepared: admitted and held, the revert committed with it, no wake",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { db } = yield* Database.Service
        const sessionID = yield* staged("ses_prompt_revert_held")
        wakes.length = 0
        preparing.run = sessions.archive(sessionID).pipe(Effect.orDie)
        const admitted = yield* sessions.prompt({ sessionID, text: "a client's prompt", source: "http" })
        preparing.run = Effect.void
        expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
        expect(yield* SessionAdmission.isHeld(db, admitted.id)).toBe(true)
        expect(wakes).toEqual([])
      }),
  )
})
