// Fork feature (synthetic-archived): the leaf probe's provoked history (leaf-review-tools/window-probe, "Provoked"),
// replayed on the real Session: a plugin's courier reads its session (live), the owner archives the session, and the
// courier's message lands. On bd244af14e the message was admitted into the archived session and woke a turn there.
// The archive is landed at the worst point: inside Session.synthetic, right after its own read of the session and
// before the inbox admission, the window the probe measured (1 to 4 ms). Only upstream modules are imported, so this
// file runs unchanged at the base to show it red there.
import { describe, expect } from "bun:test"
import type { FileSystem } from "@opencode/core/filesystem"
import { Effect, Exit, Layer, LayerMap } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { testEffect } from "./lib/effect"
import { database as testDatabase } from "./fixture/test-database"

/** Inputs each drain took, per session: a turn that ran. */
const turns: { sessionID: Session.ID; took: string[] }[] = []
/** Runs once, right after the next read of `sessionID` (the window between a read and the admission). */
const armed: { sessionID?: Session.ID; action?: Effect.Effect<void> } = {}

/** The services the drain reads, set by the test before it admits. */
const deps: { database?: Database.Service["Service"]; bus?: Bus.Service["Service"] } = {}

const runner = Layer.succeed(
  SessionRunner.Service,
  SessionRunner.Service.of({
    drain: (input) =>
      Effect.gen(function* () {
        const database = deps.database!
        const bus = deps.bus!
        const before = (yield* SessionInbox.list(database.db, input.sessionID)).map((item) => item.id)
        while (((yield* SessionInbox.promote(database.db, bus, input.sessionID, "input")) ?? 0) > 0);
        const after = new Set((yield* SessionInbox.list(database.db, input.sessionID)).map((item) => item.id))
        turns.push({ sessionID: input.sessionID, took: before.filter((id) => !after.has(id)) })
        return SessionRunner.DrainResult.Complete()
      }).pipe(Effect.orDie),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      SessionInbox.node,
      Job.node,
      KV.node,
      Session.node,
      SessionExecution.node,
    ]),
    [
      testDatabase(),
      SessionStore.node.replace(
        SessionStore.node.mapLayer((layer) =>
          Layer.effect(
            SessionStore.Service,
            Effect.gen(function* () {
              const store: SessionStore.Interface = yield* SessionStore.Service
              return SessionStore.Service.of({
                ...store,
                get: (sessionID) =>
                  store.get(sessionID).pipe(
                    Effect.tap(() => {
                      const action = armed.action
                      if (action === undefined || armed.sessionID !== sessionID) return Effect.void
                      armed.action = undefined
                      return action
                    }),
                  ),
              })
            }),
          ).pipe(Layer.provide(layer)),
        ),
      ),
      LocationServiceMap.node.replace(
        Layer.effect(
          LocationServiceMap.Service,
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only the runner is used from a Location
          LayerMap.make(() => runner as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>),
        ),
      ),
    ],
  ),
)

const seed = Effect.fnUntraced(function* (id: string) {
  const database = yield* Database.Service
  const sessionID = Session.ID.make(id)
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: id,
      directory: "/project",
      title: id,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return sessionID
})

/** The leaf probe's history: the courier reads the session, the owner archives it inside the window, the message lands. */
const provoked = Effect.fnUntraced(function* (id: string, source: "plugin" | "shell") {
  const sessions = yield* Session.Service
  const execution = yield* SessionExecution.Service
  const database = yield* Database.Service
  const sessionID = yield* seed(id)
  deps.database = database
  deps.bus = yield* Bus.Service
  // The courier's read (`ctx.session.get`): the session is live.
  expect((yield* sessions.get(sessionID)).time.archived).toBeUndefined()
  // The owner's archive (`PATCH /api/session/:id {"archived":true}`) lands after Session.synthetic's own read.
  armed.sessionID = sessionID
  armed.action = sessions.archive(sessionID).pipe(Effect.orDie)
  const inputID = SessionMessage.ID.create()
  const exit = yield* sessions
    // `source` names the caller as the fork's plugin host and shell tool do; the base ignores it.
    .synthetic({ sessionID, id: inputID, text: "the courier's letter", source } as Parameters<
      typeof sessions.synthetic
    >[0])
    .pipe(Effect.exit)
  yield* Effect.sleep(20)
  yield* execution.awaitIdle(sessionID)
  expect(armed.action).toBeUndefined()
  expect((yield* sessions.get(sessionID)).time.archived).toBeDefined()
  return {
    exit,
    row: (yield* SessionInbox.find(database.db, inputID)) !== undefined,
    turns: turns.filter((turn) => turn.sessionID === sessionID && turn.took.length > 0).length,
  }
})

describe("the leaf probe's provoked history (an archive inside the admission window)", () => {
  it.live("a plugin's letter to a session archived inside the window is refused: no row, no turn", () =>
    Effect.gen(function* () {
      const result = yield* provoked("ses_leaf_plugin", "plugin")
      // Red at bd244af14e: admitted, the row taken by a turn that ran in the archived session.
      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.row).toBe(false)
      expect(result.turns).toBe(0)
    }),
  )

  it.live("a shell's notice to a session archived inside the window is held: its row stays, no turn", () =>
    Effect.gen(function* () {
      const result = yield* provoked("ses_leaf_shell", "shell")
      // Red at bd244af14e: the notice woke a turn in the archived session and was taken.
      expect(Exit.isSuccess(result.exit)).toBe(true)
      expect(result.row).toBe(true)
      expect(result.turns).toBe(0)
    }),
  )
})
