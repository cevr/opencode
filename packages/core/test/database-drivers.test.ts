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
import { Event } from "@opencode/schema/event"
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

type Entry = "db" | "client" | "tx"
type Entries = ReadonlyArray<Entry>
const publications = ["publish", "publishAll", "replay"] as const
type MixedHistory = {
  readonly entries: Entries
  readonly publication: (typeof publications)[number]
  readonly failure?: { readonly level: number; readonly caught: boolean }
  readonly callbackFirst: boolean
  readonly rollback: boolean
}

// tx.transaction is available after a Drizzle callback has supplied a handle, including under a raw inner scope.
const chains = (prefix: Entries = []): Entries[] => {
  if (prefix.length === 3) return [prefix]
  const next: Entries = prefix.includes("db") ? ["db", "client", "tx"] : ["db", "client"]
  return [...(prefix.length ? [prefix] : []), ...next.flatMap((entry) => chains([...prefix, entry]))]
}

const mixedHistories: MixedHistory[] = chains().flatMap((entries) => {
  const innerFailures = entries
    .slice(1)
    .flatMap((_, i) => [true, false].map((caught) => ({ level: i + 1, caught })))
  return [undefined, ...innerFailures].flatMap((failure) =>
    [true, false].flatMap((callbackFirst) =>
      [true, false].flatMap((rollback) =>
        publications.map((publication) => ({ entries, failure, callbackFirst, rollback, publication })),
      ),
    ),
  )
})

const title = (level: number) => `rename:${level}`
const callback = (level: number, source: "sql" | "drizzle") => `${source}:${level}`
const issued = (level: number, callbackFirst: boolean) =>
  callbackFirst
    ? [callback(level, "sql"), title(level), callback(level, "drizzle")]
    : [callback(level, "drizzle"), title(level), callback(level, "sql")]

// Reference model: provisional work forms a prefix. A caught savepoint failure discards its level and all descendants;
// without savepoints it invalidates the root. Visibility comes after every transaction body has unwound.
const expectedMixed = (driver: Driver, history: MixedHistory) => {
  const { entries, failure, rollback, callbackFirst } = history
  const failed = rollback || (failure !== undefined && (!failure.caught || driver === "durable-object"))
  const visited = entries.map((_, i) => i)
  const committed = failed ? [] : visited.slice(0, failure?.level ?? visited.length)
  return {
    failed,
    rows: committed.map(title),
    trace: [
      ...visited.map((i) => `enter:${i}`),
      ...visited.toReversed().map((i) => `exit:${i}`),
      ...committed.flatMap((i) => issued(i, callbackFirst)),
    ],
  }
}

const runMixed = Effect.fnUntraced(function* (history: MixedHistory) {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const sessionID = Session.ID.create()
  const trace: string[] = []
  const { entries, failure, rollback, callbackFirst, publication } = history
  type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
  const record = (entry: string) => Effect.sync(() => void trace.push(entry))
  const unsubscribe = yield* bus.listen((event) => record((event.data as { title: string }).title))
  const sqlNote = (level: number) => db.$client.afterCommit(record(callback(level, "sql")))
  const drizzleNote = (level: number) => afterCommit(db.$client, record(callback(level, "drizzle")))
  const publish = (level: number) => {
    const data = { sessionID, title: title(level) }
    switch (publication) {
      case "publish":
        return bus.publish(SessionEvent.Renamed, data)
      case "publishAll":
        return bus.publishAll([[SessionEvent.Renamed, data]])
      case "replay":
        return bus.replay(
          {
            id: Event.ID.create(),
            type: Bus.versionedType(SessionEvent.Renamed.type, SessionEvent.Renamed.durable.version),
            seq: level,
            aggregateID: sessionID,
            data,
          },
          { publish: true },
        )
    }
  }
  const visit = (level: number, tx: Transaction | undefined): Effect.Effect<void, unknown> => {
    const body = (handle: Transaction | undefined) =>
      Effect.gen(function* () {
        yield* record(`enter:${level}`)
        yield* callbackFirst ? sqlNote(level) : drizzleNote(level)
        yield* publish(level)
        yield* callbackFirst ? drizzleNote(level) : sqlNote(level)
        if (level + 1 < entries.length) {
          const child = visit(level + 1, handle)
          if (failure?.caught && failure.level === level + 1)
            yield* child.pipe(Effect.catch((error) => (error instanceof Abort ? Effect.void : Effect.fail(error))))
          else yield* child
        }
        if (failure?.level === level || (level === 0 && rollback)) return yield* new Abort()
      }).pipe(Effect.onExit(() => record(`exit:${level}`)))

    switch (entries[level]) {
      case "db":
        return db.transaction(body, immediate)
      case "client":
        return db.$client.withTransaction(body(tx))
      case "tx":
        if (tx) return tx.transaction(body)
    }
    return Effect.die(new Error(`Invalid transaction history at level ${level}`))
  }
  const outcome = yield* visit(0, undefined).pipe(Effect.exit, Effect.ensuring(unsubscribe))
  const rows = Array.from(yield* Stream.runCollect(bus.log({ aggregateID: sessionID })))
    .filter((item) => !Bus.isSynced(item))
    .map((item) => (item as { data: { title: string } }).data.title)
  return { failed: Exit.isFailure(outcome), rows, trace }
})

for (const driver of ["bun:sqlite", "durable-object"] as const) {
  test(`${driver}: ${mixedHistories.length} mixed-entry histories agree with the transaction model`, () =>
    Effect.gen(function* () {
      for (const history of mixedHistories) {
        expect({ history, actual: yield* runMixed(history) }).toEqual({
          history,
          actual: expectedMixed(driver, history),
        })
      }
    }).pipe(Effect.provide(layer(driver)), Effect.scoped, Effect.runPromise),
  )
}

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

  test("Durable Object SQLite: a durable publish joins an outer SQL client transaction", async () => {
    const durable = await run("durable-object", (tools) =>
      tools.db.$client.withTransaction(
        rename(tools, "phantom").pipe(Effect.andThen(tools.note("phantom work")), Effect.andThen(new Abort())),
      ),
    )
    expect(durable).toEqual({ rows: [], routed: [], work: [], error: "Abort" })
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
