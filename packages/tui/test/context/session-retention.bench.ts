// What a long-lived family's finished subagents cost the TUI, with and without the idle window.
// Run: bun test/context/session-retention.bench.ts [children=170] [messages=100] [bytes=2000]
// A root holds `children` subagents whose transcripts are loaded (`messages` rows of `bytes` text each,
// the shape `session.created` plus live events leave behind), all finished. It prints the heap after GC
// and the time of one walk over every loaded row of the family through the store, the O(messages)
// pass a family-wide memo makes, before and after the retention's idle window drops the finished ones.
import { createData, createSessionRetention } from "@opencode/client/solid"
import type { OpenCodeEvent } from "@opencode/client"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { heapStats } from "bun:jsc"
import { createRoot, createSignal } from "solid-js"
import { createApi, createFetch, directory, json } from "../fixture/tui-client"

const [children = 170, perSession = 100, bytes = 2_000] = process.argv.slice(2).map(Number)
const text = "x".repeat(bytes)

const heapMB = () => {
  Bun.gc(true)
  return heapStats().heapSize / 1024 / 1024
}

const before = heapMB()
const scope = createRoot((dispose) => {
  const events = createGlobalEmitter<{ [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }>()
  const api = createApi(
    createFetch((url) => {
      const sessionID = url.pathname.split("/")[3] ?? "session"
      if (url.pathname.endsWith("/message"))
        return json({
          data: Array.from({ length: perSession }, (_, index) => ({
            id: `msg_${sessionID}_${String(perSession - index).padStart(4, "0")}`,
            type: "user",
            text: `${sessionID} ${index} ${text}`,
            time: { created: perSession - index },
          })),
          cursor: {},
        })
      if (url.pathname.endsWith("/inbox")) return json({ data: [] })
      return undefined
    }).fetch,
  )
  const data = createData({ api: () => api, event: events, directory, initialMessageLimit: () => perSession })
  const [idle, setIdle] = createSignal(false)
  createSessionRetention({
    session: data.session,
    current: () => "root",
    keep: () => [],
    limit: 3,
    idle: { after: 5 * 60_000, now: () => (idle() ? 10 * 60_000 : 0) },
  })
  return { data, dispose, setIdle }
})

const remember = (id: string, parentID?: string) =>
  scope.data.session.remember({
    id,
    parentID,
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0, idle: 1 },
  })

const ids = ["root", ...Array.from({ length: children }, (_, index) => `child${index}`)]
remember("root")
ids.slice(1).forEach((id) => remember(id, "root"))
for (const id of ids) await scope.data.session.message.sync(id)

const walk = () => {
  const started = performance.now()
  let total = 0
  for (let round = 0; round < 10; round++)
    for (const id of scope.data.session.family("root"))
      for (const message of scope.data.session.message.list(id))
        total += message.type === "user" ? message.text.length : 0
  return { ms: (performance.now() - started) / 10, total }
}

const report = (label: string) => {
  const rows = ids.reduce((sum, id) => sum + scope.data.session.message.list(id).length, 0)
  const { ms } = walk()
  console.log(
    `${label}: ${rows} rows loaded, heap ${(heapMB() - before).toFixed(1)} MB over baseline, walk ${ms.toFixed(2)} ms`,
  )
}

report(`${children} finished subagents x ${perSession} rows, inside the window`)
// Idle past the window: the retention drops every finished subagent's transcript and keeps the root's.
scope.setIdle(true)
report("past the idle window")
scope.dispose()
