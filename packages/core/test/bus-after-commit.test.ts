// Fork feature (synthetic-archived): a durable publish inside a caller's transaction is routed (projectors aside:
// listeners, subscribers, aggregate wakes) only once the outermost transaction commits, and never when it rolls back.
// Upstream routes it when the publish's own savepoint returns, so a listener sees an event whose row the outer
// transaction then rolls back (the "phantom route"): the first test is red at the base.
import { describe, expect } from "bun:test"
import { Data, Effect, Exit, Layer, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Workspace } from "@opencode/core/workspace"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { database } from "./fixture/test-database"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Location.node]), [
    database(),
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location({ directory: AbsolutePath.make("project"), workspaceID: Workspace.ID.make("wrk_test") }),
        ),
      ),
    ),
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
)

class Abort extends Data.TaggedError("Abort")<{}> {}

const setup = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const { db } = yield* Database.Service
  const seen: string[] = []
  yield* bus.listen((event) => Effect.sync(() => void seen.push(event.type)))
  return { bus, db, seen, sessionID: Session.ID.create() }
})

describe("a durable publish inside a caller's transaction", () => {
  it.effect("rolled back with it: never routed, no row", () =>
    Effect.gen(function* () {
      const { bus, db, seen, sessionID } = yield* setup
      const exit = yield* db
        .transaction(
          () =>
            bus
              .publish(SessionEvent.Renamed, { sessionID, title: "phantom" })
              .pipe(Effect.andThen(Effect.fail(new Abort()))),
          { behavior: "immediate" },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      yield* Effect.yieldNow
      expect(seen).toEqual([])
      const logged = Array.from(yield* Stream.runCollect(bus.log({ aggregateID: sessionID })))
      expect(logged.filter((item) => !Bus.isSynced(item))).toEqual([])
    }),
  )

  it.effect("committed with it: routed after the commit, in order", () =>
    Effect.gen(function* () {
      const { bus, db, seen, sessionID } = yield* setup
      const inside = yield* db.transaction(
        () =>
          Effect.gen(function* () {
            yield* bus.publish(SessionEvent.Renamed, { sessionID, title: "one" })
            yield* bus.publish(SessionEvent.Renamed, { sessionID, title: "two" })
            return [...seen]
          }),
        { behavior: "immediate" },
      )
      expect(inside).toEqual([])
      expect(seen).toEqual([SessionEvent.Renamed.type, SessionEvent.Renamed.type])
    }),
  )

  it.effect("outside any transaction: routed at once, as upstream", () =>
    Effect.gen(function* () {
      const { bus, seen, sessionID } = yield* setup
      yield* bus.publish(SessionEvent.Renamed, { sessionID, title: "now" })
      expect(seen).toEqual([SessionEvent.Renamed.type])
    }),
  )
})
