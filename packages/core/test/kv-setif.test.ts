// KV.setIf: a write that lands only on the value its writer read, so two writers over one database (two connections,
// or two OpenCode processes) never both win a round and no update is lost.
import { afterAll, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KV } from "@opencode/core/kv"
import { tmpdir } from "./fixture/tmpdir"

const runtimes: Array<ManagedRuntime.ManagedRuntime<KV.Service, never>> = []
afterAll(() => Promise.all(runtimes.map((runtime) => runtime.dispose())))

/** A connection of its own over the database file `file`. */
const connection = (file: string) => {
  const runtime = ManagedRuntime.make(AppNodeBuilder.build(KV.node, [Database.node.replace(Database.configured({ path: file }))]))
  runtimes.push(runtime)
  return <A>(body: (kv: KV.Interface) => Effect.Effect<A>) => runtime.runPromise(KV.Service.use(body))
}

const database = async () => path.join((await tmpdir()).path, "opencode.db")

describe("KV.setIf", () => {
  test("with no rev it inserts only an absent key", async () => {
    const kv = connection(await database())
    expect(await kv((each) => each.setIf("k", { rev: 1, v: "first" }, undefined))).toBe(true)
    expect(await kv((each) => each.setIf("k", { rev: 1, v: "second" }, undefined))).toBe(false)
    expect(await kv((each) => each.get("k"))).toEqual({ rev: 1, v: "first" })
  })

  test("with a rev it writes only over the value of that rev; a value without one counts as rev 0", async () => {
    const kv = connection(await database())
    await kv((each) => each.set("old", { v: "no rev" }))
    expect(await kv((each) => each.setIf("old", { rev: 1, v: "a" }, 1))).toBe(false)
    expect(await kv((each) => each.setIf("old", { rev: 1, v: "a" }, 0))).toBe(true)
    expect(await kv((each) => each.setIf("old", { rev: 2, v: "b" }, 0))).toBe(false)
    expect(await kv((each) => each.setIf("old", { rev: 2, v: "b" }, 1))).toBe(true)
    expect(await kv((each) => each.get("old"))).toEqual({ rev: 2, v: "b" })
    // An absent key has no rev to match.
    expect(await kv((each) => each.setIf("none", { rev: 1 }, 0))).toBe(false)
    expect(await kv((each) => each.get("none"))).toBeUndefined()
  })

  test("two connections that read the same rev: exactly one wins each of 1,000 rounds", async () => {
    const file = await database()
    const first = connection(file)
    const second = connection(file)
    const wins: Array<number> = []
    for (let round = 0; round < 1_000; round++) {
      const rev = round === 0 ? undefined : round
      const both = await Promise.all([first((kv) => kv.setIf("race", { rev: round + 1, by: "first" }, rev)), second((kv) => kv.setIf("race", { rev: round + 1, by: "second" }, rev))])
      wins.push(both.filter(Boolean).length)
    }
    expect(wins.every((count) => count === 1)).toBe(true)
    expect(((await first((kv) => kv.get("race"))) as { rev: number }).rev).toBe(1_000)
  })

  test("two processes raising one counter 1,000 times each lose no update", async () => {
    const file = await database()
    // Create the schema once before the writers race to open it.
    await connection(file)((kv) => kv.get("counter"))
    const writer = path.join(import.meta.dir, "fixture", "kv-setif-writer.ts")
    const run = () => Bun.spawn(["bun", writer, file, "counter", "1000"], { stdout: "pipe", stderr: "inherit", cwd: import.meta.dir })
    const writers = [run(), run()]
    const exits = await Promise.all(writers.map((each) => each.exited))
    expect(exits).toEqual([0, 0])
    const stored = (await connection(file)((kv) => kv.get("counter"))) as { rev: number; count: number }
    expect(stored).toEqual({ rev: 2_000, count: 2_000 })
    // Measured: each writer lost hundreds of rounds to the other (e.g. 381 and 227), each read again and retried.
  }, 60_000)
})
