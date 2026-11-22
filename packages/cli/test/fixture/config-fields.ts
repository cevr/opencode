import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { Config } from "../../src/config"

// One TUI's saves of its own field: once `go` exists, `count` updates in a row, as a TUI saves a setting
// the owner changes again and again. Two of these at once share one cli.json.
const [field, directory, go, count] = process.argv.slice(2)
if (!directory || !go || !count) throw new Error("missing config fields arguments")
if (field !== "theme" && field !== "scope") throw new Error(`unknown field: ${field}`)

const service = await Effect.runPromise(
  Config.Service.pipe(
    Effect.provide(Config.layer),
    Effect.provide(Global.layerWith({ config: directory, state: directory })),
    Effect.provide(NodeFileSystem.layer),
  ),
)

while (!(await Bun.file(go).exists())) await Bun.sleep(5)
const total = Number(count)
for (let at = 1; at <= total; at++) {
  await Effect.runPromise(
    service.update((draft) => {
      if (field === "theme") draft.theme = { ...draft.theme, name: `theme-${at}` }
      else draft.tabs = { ...draft.tabs, scope: at % 2 === 0 ? "cwd" : "global" }
    }),
  )
}
