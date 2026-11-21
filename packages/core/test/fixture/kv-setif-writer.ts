// One writer process for kv-setif.test.ts: `rounds` read → raise rev → setIf, retrying a lost round, over the
// database file `file` (its own connection, as a second OpenCode process has). Prints how many rounds it won.
//   bun kv-setif-writer.ts <file> <key> <rounds>
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KV } from "@opencode/core/kv"

const [file = "", key = "", rounds = "0"] = process.argv.slice(2)
const runtime = ManagedRuntime.make(AppNodeBuilder.build(KV.node, [Database.node.replace(Database.configured({ path: file }))]))

const raise = Effect.gen(function* () {
  const kv = yield* KV.Service
  let lost = 0
  for (let won = 0; won < Number(rounds); ) {
    const read = (yield* kv.get(key)) as { rev: number; count: number } | undefined
    const rev = read?.rev
    const next = { rev: (rev ?? 0) + 1, count: (read?.count ?? 0) + 1 }
    if (yield* kv.setIf(key, next, rev)) won += 1
    else lost += 1
  }
  return lost
})

const lost = await runtime.runPromise(raise)
await runtime.dispose()
console.log(JSON.stringify({ lost }))
