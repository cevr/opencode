// Fork feature (synthetic-archived): the same scripted histories of transactions and durable publishes on bun:sqlite
// and on Durable Object SQLite (emulated, fixture/durable-object-storage.ts), which manages its transactions itself,
// has no savepoints and no rollback callback. Each history's rows, routed events and error must be the same on both,
// except the one documented difference: a nested transaction that fails while its caller carries on rolls back to its
// savepoint on bun:sqlite, and dooms the whole transaction on Durable Object SQLite (NestedTransactionFailed).
// "a rolled-back transaction routes nothing" is red on round 3's head for Durable Object SQLite: there `afterCommit`
// used the client's own hook, which ran the work at once.
import { describe, expect, test } from "bun:test"
import { Cause, Data, Effect, Exit, Layer, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { afterCommit } from "@opencode/core/database/drizzle/effect-sqlite/session"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Workspace } from "@opencode/core/workspace"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "./fixture/location"
import { databaseOn, type Driver } from "./fixture/test-database"

const layer = (on: Driver) =>
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Location.node]), [
    databaseOn(on),
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location({ directory: AbsolutePath.make("project"), workspaceID: Workspace.ID.make("wrk_test") }),
        ),
      ),
    ),
    Bus.node.replace(Bus.configured({ persist: true })),
  ])

class Abort extends Data.TaggedError("Abort")<{}> {}

type Tools = {
  readonly bus: Bus.Interface
  readonly db: Database.Interface["db"]
  readonly sessionID: Session.ID
  readonly note: (entry: string) => Effect.Effect<void>
}
type History = (tools: Tools) => Effect.Effect<unknown, unknown>

const errorOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  if (error instanceof Abort) return "Abort"
  // A statement's failure arrives as drizzle's query error, its cause the SqlError: the doom is found down the chain.
  for (
    let link: unknown = error;
    link instanceof Error;
    link = Cause.isCause(link.cause) ? Cause.squash(link.cause) : link.cause
  )
    if (link.message.startsWith("NestedTransactionFailed")) return link.message
  return `other: ${error instanceof Error ? error.message : String(error)}`
}

/** Runs a history on a fresh database of the driver: its committed rows, the events routed, after-commit work, error. */
const run = (on: Driver, history: History) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    const sessionID = Session.ID.create()
    const routed: string[] = []
    const work: string[] = []
    yield* bus.listen((event) =>
      Effect.sync(() => void routed.push(`${event.type}:${(event.data as { title?: string }).title ?? ""}`)),
    )
    const note = (entry: string) =>
      afterCommit(
        db.$client,
        Effect.sync(() => void work.push(entry)),
      )
    const exit = yield* Effect.exit(history({ bus, db, sessionID, note }))
    yield* Effect.yieldNow
    const rows = Array.from(yield* Stream.runCollect(bus.log({ aggregateID: sessionID })))
      .filter((item) => !Bus.isSynced(item))
      .map((item) => (item as { data: { title: string } }).data.title)
    return { rows, routed, work, error: Exit.isSuccess(exit) ? undefined : errorOf(exit.cause) }
  }).pipe(Effect.provide(layer(on)), Effect.scoped, Effect.runPromise)

const rename = (tools: Tools, title: string) =>
  tools.bus.publish(SessionEvent.Renamed, { sessionID: tools.sessionID, title })

const immediate = { behavior: "immediate" } as const

const histories: Record<string, History> = {
  "a publish outside any transaction": (tools) => rename(tools, "now"),
  "a committed transaction": (tools) =>
    tools.db.transaction(
      () =>
        Effect.gen(function* () {
          yield* rename(tools, "one")
          yield* tools.note("work")
          yield* rename(tools, "two")
        }),
      immediate,
    ),
  "a rolled-back transaction routes nothing": (tools) =>
    tools.db.transaction(
      () =>
        Effect.gen(function* () {
          yield* rename(tools, "phantom")
          yield* tools.note("phantom work")
          return yield* new Abort()
        }),
      immediate,
    ),
  "a nested transaction, committed with its outer": (tools) =>
    tools.db.transaction(
      () =>
        Effect.gen(function* () {
          yield* rename(tools, "outer")
          yield* tools.db.transaction(() => rename(tools, "inner").pipe(Effect.andThen(tools.note("inner work"))))
          yield* tools.note("outer work")
        }),
      immediate,
    ),
  "a nested transaction fails and its caller rethrows": (tools) =>
    tools.db.transaction(
      () =>
        Effect.gen(function* () {
          yield* rename(tools, "outer")
          yield* tools.db.transaction(() =>
            rename(tools, "inner").pipe(Effect.andThen(tools.note("inner work")), Effect.andThen(new Abort())),
          )
        }),
      immediate,
    ),
}

/** The one history whose outcome differs by driver: the caller swallows its nested transaction's failure. */
const swallowed: History = (tools) =>
  tools.db.transaction(
    () =>
      Effect.gen(function* () {
        yield* rename(tools, "outer")
        yield* tools.db
          .transaction(() =>
            rename(tools, "inner").pipe(Effect.andThen(tools.note("inner work")), Effect.andThen(new Abort())),
          )
          .pipe(Effect.ignore)
        yield* tools.note("outer work")
        yield* rename(tools, "after")
      }),
    immediate,
  )

describe("the same histories on bun:sqlite and Durable Object SQLite", () => {
  for (const [name, history] of Object.entries(histories))
    test(name, async () => {
      const bun = await run("bun:sqlite", history)
      const durable = await run("durable-object", history)
      expect(durable).toEqual(bun)
    })

  test("the expected outcomes on bun:sqlite", async () => {
    const renamed = SessionEvent.Renamed.type
    expect(await run("bun:sqlite", histories["a rolled-back transaction routes nothing"]!)).toEqual({
      rows: [],
      routed: [],
      work: [],
      error: "Abort",
    })
    expect(await run("bun:sqlite", histories["a nested transaction, committed with its outer"]!)).toEqual({
      rows: ["outer", "inner"],
      routed: [`${renamed}:outer`, `${renamed}:inner`],
      work: ["inner work", "outer work"],
      error: undefined,
    })
    expect(await run("bun:sqlite", histories["a nested transaction fails and its caller rethrows"]!)).toEqual({
      rows: [],
      routed: [],
      work: [],
      error: "Abort",
    })
  })

  test("a nested failure swallowed: bun:sqlite rolls back to its savepoint; Durable Object SQLite dooms it, loudly", async () => {
    const renamed = SessionEvent.Renamed.type
    expect(await run("bun:sqlite", swallowed)).toEqual({
      rows: ["outer", "after"],
      routed: [`${renamed}:outer`, `${renamed}:after`],
      work: ["outer work"],
      error: undefined,
    })
    // Durable Object SQLite: the statement after the swallowed failure fails, naming it; nothing commits or runs.
    const durable = await run("durable-object", swallowed)
    expect(durable).toMatchObject({ rows: [], routed: [], work: [] })
    expect(durable.error).toStartWith("NestedTransactionFailed: a nested transaction failed (")
    expect(durable.error).toContain("Abort")
  })

  test("Durable Object SQLite: a doomed transaction's later statements fail at once, naming the inner failure", async () => {
    const seen: string[] = []
    const history: History = (tools) =>
      tools.db.transaction(
        () =>
          Effect.gen(function* () {
            yield* tools.db.transaction(() => Effect.fail(new Abort())).pipe(Effect.ignore)
            const later = yield* Effect.exit(tools.db.run("select 1"))
            seen.push(Exit.isSuccess(later) ? "ran" : errorOf(later.cause))
          }),
        immediate,
      )
    const durable = await run("durable-object", history)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toStartWith("NestedTransactionFailed: a nested transaction failed (")
    expect(durable.error).toStartWith("NestedTransactionFailed")
  })

  test("a doomed transaction whose caller also swallows the later failures still fails at its commit", async () => {
    const history: History = (tools) =>
      tools.db.transaction(
        () =>
          Effect.gen(function* () {
            yield* tools.db.transaction(() => Effect.fail(new Abort())).pipe(Effect.ignore)
            yield* rename(tools, "after").pipe(Effect.ignore)
            yield* tools.note("work")
          }),
        immediate,
      )
    const durable = await run("durable-object", history)
    expect(durable).toMatchObject({ rows: [], routed: [], work: [] })
    expect(durable.error).toStartWith("NestedTransactionFailed")
    expect(await run("bun:sqlite", history)).toEqual({
      rows: ["after"],
      routed: [`${SessionEvent.Renamed.type}:after`],
      work: ["work"],
      error: undefined,
    })
  })
})
