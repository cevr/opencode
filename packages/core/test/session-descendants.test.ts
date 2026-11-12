import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { sqliteLayer } from "@opencode/core/database/sqlite.workerd"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeDurableObjectStorage } from "./fixture/durable-object-storage"
import { promptLocationNode } from "./fixture/prompt-location"
import { globalProjectNode } from "./lib/project"
import { testEffect } from "./lib/effect"

// Every SQL statement the store runs, counted at the storage seam.
const statements = { count: 0 }
const countingStorage = () => {
  const storage = makeDurableObjectStorage()
  const exec = storage.sql.exec.bind(storage.sql)
  storage.sql.exec = (query: string, ...bindings: Array<unknown>) => {
    statements.count++
    return exec(query, ...bindings)
  }
  return storage
}

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionStore.node, Session.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
    Project.node.replace(globalProjectNode),
    LocationServiceMap.node.replace(promptLocationNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    Database.node.replace(Database.configuredClient(Layer.suspend(() => sqliteLayer({ storage: countingStorage() })))),
  ]),
)

const projectID = Project.ID.make("descendants-project")

// Seeded so a failure replays.
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

type Shape = "random" | "wide" | "deep"

// A family of `size` sessions: node 0 is the root, every other node's parent comes before it.
// Few distinct update times, so siblings tie on time and order by id.
function family(shape: Shape, size: number, next: () => number) {
  return Array.from({ length: size }, (_, index) => ({
    id: Session.ID.create(),
    parent:
      index === 0
        ? undefined
        : shape === "wide"
          ? next() < 0.9
            ? 0
            : Math.floor(next() * index)
          : shape === "deep"
            ? next() < 0.9
              ? index - 1
              : Math.floor(next() * index)
            : Math.floor(next() * index),
    updated: 1_000 + Math.floor(next() * 40),
  }))
}

const seed = Effect.fn(function* (
  nodes: ReadonlyArray<{ id: Session.ID; parent: number | undefined; updated: number }>,
) {
  const { db } = yield* Database.Service
  // One row a statement: Durable Object SQLite binds at most 100 parameters.
  for (const node of nodes)
    yield* db
      .insert(SessionTable)
      .values({
        id: node.id,
        project_id: projectID,
        parent_id: node.parent === undefined ? null : nodes[node.parent]!.id,
        slug: node.id,
        directory: "/descendants",
        version: "test",
        time_created: node.updated,
        time_updated: node.updated,
      })
      .run()
      .pipe(Effect.orDie)
})

// The family request's walk before the descendants query: one paged child list per member.
const pagedFamily = Effect.fn(function* (root: Session.ID) {
  const session = yield* Session.Service
  const members: Session.Info[] = [yield* session.get(root).pipe(Effect.orDie)]
  for (let index = 0; index < members.length; index++) {
    let page = yield* session.list({ parentID: members[index]!.id, limit: 200 }).pipe(Effect.orDie)
    members.push(...page.data)
    while (page.cursor.next) {
      page = yield* session.list({ cursor: page.cursor.next, limit: 200 }).pipe(Effect.orDie)
      members.push(...page.data)
    }
  }
  return members.slice(1)
})

describe("Session.descendants", () => {
  it.effect("reads an 800-session family in one statement, as the paged walk reads it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const session = yield* Session.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/descendants"), name: "descendants", sandboxes: [] })
        .run()
        .pipe(Effect.orDie)

      const next = random(0x5eed)
      const shapes: Shape[] = ["random", "wide", "deep", "random", "wide", "deep"]
      const families = shapes.map((shape) => family(shape, 800, next))
      for (const nodes of families) yield* seed(nodes)
      // A fork of a member is not under it.
      yield* db
        .insert(SessionTable)
        .values({
          id: Session.ID.create(),
          project_id: projectID,
          fork_session_id: families[0]![1]!.id,
          slug: "fork",
          directory: "/descendants",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      for (const nodes of families) {
        const root = nodes[0]!.id
        statements.count = 0
        const before = yield* pagedFamily(root)
        const paged = statements.count
        statements.count = 0
        const after = yield* session.descendants(root)
        expect(statements.count).toBe(1)
        expect(paged).toBeGreaterThan(nodes.length)
        expect(after).toEqual(before)
        expect(after.map((info) => info.id).toSorted()).toEqual(nodes.slice(1).map((node) => node.id).toSorted())
      }
      // A child reads its own subtree; a leaf has none.
      const subtree = families[0]![1]!.id
      expect((yield* session.descendants(subtree)).map((info) => info.id)).toEqual(
        (yield* pagedFamily(subtree)).map((info) => info.id),
      )
      const leaf = families[2]!.at(-1)!.id
      expect(yield* session.descendants(leaf)).toEqual([])
    }),
  )
})
