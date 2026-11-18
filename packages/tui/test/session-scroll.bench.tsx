// Scroll cost on a long transcript: the time each mouse-wheel step takes (event, layout and paint) while the
// reader scrolls from the bottom of a long session to its first message and back down. Not part of the suite
// (no `.test.` in its name); run it by path: `bun test ./test/session-scroll.bench.tsx`.
// Knobs (env): SCROLL_TURNS (400), SCROLL_UP (600 steps), SCROLL_DOWN (300 steps), SCROLL_PAGE_MS (0: the
// fixture server's delay per older page).
import { expect, test } from "bun:test"
import { getTreeSitterClient, ScrollBoxRenderable, type Renderable } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { Session } from "node:inspector"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"

const TURNS = Number(process.env.SCROLL_TURNS ?? 400)
const UP = Number(process.env.SCROLL_UP ?? 600)
const DOWN = Number(process.env.SCROLL_DOWN ?? 300)
const PAGE_MS = Number(process.env.SCROLL_PAGE_MS ?? 0)
const PACE_MS = Number(process.env.SCROLL_PACE_MS ?? 16)
// TUI plugins by absolute path (comma list), e.g. the dotfiles' cmd/prime, with SCROLL_THEME its theme file.
const PLUGINS = (process.env.SCROLL_PLUGINS ?? "").split(",").filter(Boolean)
const THEME = process.env.SCROLL_THEME
const HIGHLIGHT_MS = Number(process.env.SCROLL_HIGHLIGHT_MS ?? 0)

const answer = (turn: number) =>
  [
    `## Turn ${turn} findings`,
    "",
    `The change in turn ${turn} touches **three** files; the reader sees each one below with its reason.`,
    "",
    "- `src/routes/session/index.tsx` mounts the rows",
    "- `src/routes/session/history.ts` loads the older page",
    "- `src/context/data.ts` publishes it",
    "",
    "```ts",
    `export const turn${turn} = (value: number) => value * ${turn}`,
    `export const label${turn} = "turn ${turn}"`,
    "```",
    "",
    `Done with turn ${turn}.`,
  ].join("\n")

const session = {
  id: "ses_scroll_bench",
  title: "Scroll bench",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const model = { providerID: "fixture", id: "fixture" }
const id = (turn: number, role: number) => `msg_${String(turn).padStart(6, "0")}_${role}`
const messages: SessionMessageInfo[] = Array.from({ length: TURNS }, (_, turn) => [
  { type: "user" as const, id: id(turn, 0), text: `Scroll prompt ${turn}: look at the next part`, time: { created: turn * 10 } },
  {
    type: "assistant" as const,
    id: id(turn, 1),
    agent: "build",
    model,
    finish: "stop" as const,
    time: { created: turn * 10 + 1, completed: turn * 10 + 5 },
    content: [
      { type: "text" as const, text: `Looking at turn ${turn}.` },
      ...Array.from({ length: 3 }, (_, index) => ({
        type: "tool" as const,
        id: `shell-${turn}-${index}`,
        name: "shell",
        time: { created: turn * 10 + 2, completed: turn * 10 + 3 },
        state: {
          status: "completed" as const,
          input: { command: `rg -n "turn ${turn}" src --step ${index}` },
          content: [{ type: "text" as const, text: `src/a.ts:${index}: turn ${turn} step ${index}` }] as [
            { type: "text"; text: string },
          ],
          metadata: {},
        },
      })),
      { type: "text" as const, text: answer(turn) },
    ],
  },
]).flat()

const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  const sum = values.reduce((a, b) => a + b, 0)
  return {
    steps: values.length,
    totalMs: Math.round(sum),
    meanMs: +(sum / Math.max(1, values.length)).toFixed(2),
    p50Ms: +at(0.5).toFixed(2),
    p95Ms: +at(0.95).toFixed(2),
    maxMs: +at(1).toFixed(2),
  }
}

test(
  "scroll cost on a long transcript",
  async () => {
    // How long the syntax highlighter's worker takes to answer each block, and how many wait on it at once:
    // a finished reply's block shows nothing until it answers (see session-markdown-first-paint.test.tsx).
    const client = getTreeSitterClient()
    const highlightOnce = client.highlightOnce.bind(client)
    const highlights: number[] = []
    let waiting = 0
    let mostWaiting = 0
    // SCROLL_HIGHLIGHT_MS models a starved worker: it answers one block at a time, that much later each.
    let queue = Promise.resolve()
    client.highlightOnce = async (...args: Parameters<typeof highlightOnce>) => {
      const at = performance.now()
      mostWaiting = Math.max(mostWaiting, ++waiting)
      try {
        if (HIGHLIGHT_MS) {
          const turn = queue.then(() => Bun.sleep(HIGHLIGHT_MS))
          queue = turn
          await turn
        }
        return await highlightOnce(...args)
      } finally {
        waiting--
        highlights.push(performance.now() - at)
      }
    }
    const pages: number[] = []
    await using app = await createAppFixture({
      width: 120,
      height: 40,
      args: { sessionID: session.id },
      config: {
        animations: false,
        session: { verbosity: "medium" },
        ...(PLUGINS.length ? { plugins: PLUGINS, theme: { name: "prime", mode: "dark" as const } } : {}),
      },
      themes: THEME ? { prime: await Bun.file(THEME).json() } : undefined,
      fetch: async (url) => {
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${session.id}/message`) {
          const cursor = url.searchParams.get("cursor")
          const limit = Number(url.searchParams.get("limit") ?? 20)
          const end = Number(cursor ?? messages.length)
          const start = Math.max(0, end - limit)
          if (cursor) {
            pages.push(end)
            if (PAGE_MS) await Bun.sleep(PAGE_MS)
          }
          return json({ data: messages.slice(start, end).toReversed(), cursor: start ? { next: String(start) } : {} })
        }
        if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/permission")) return json({ data: [] })
        // Plugin RPCs (SCROLL_PLUGINS, e.g. Prime's wake and queue readers): nothing pending.
        if (PLUGINS.length && url.pathname.startsWith("/api/rpc/")) return json({ output: null })
      },
    })
    await app.ready
    await waitForHighlightedFrame(app, (frame) => frame.includes(`Done with turn ${TURNS - 1}`))
    await app.waitForVisualIdle({ quietFrames: 3 })
    const find = (node: Renderable): ScrollBoxRenderable | undefined =>
      node instanceof ScrollBoxRenderable && node.getRenderable(id(TURNS - 1, 0))
        ? node
        : node.getChildren().map(find).find(Boolean)
    const scroll = find(app.renderer.root)
    if (!scroll) throw new Error("Missing transcript")
    const x = scroll.viewport.x + 2
    const y = scroll.viewport.y + 2
    // One wheel step every PACE_MS, as a reader's wheel sends them; a step is stalled when the view did not move.
    const run = async (direction: "up" | "down", limit: number, done: () => boolean) => {
      const steps: number[] = []
      let stalled = 0
      let blank = 0
      const moved: number[] = []
      const mounted: number[] = []
      const cpu = process.cpuUsage()
      const started = performance.now()
      for (let i = 0; i < limit && !done(); i++) {
        const before = scroll.scrollTop
        const children = scroll.content.getChildren().length
        const at = performance.now()
        await app.mockMouse.scroll(x, y, direction)
        await app.renderOnce()
        const took = performance.now() - at
        steps.push(took)
        // A step that mounted rows (older rows revealed or a page published) against one that only moved.
        ;(scroll.content.getChildren().length === children ? moved : mounted).push(took)
        if (scroll.scrollTop === before) stalled++
        // A frame with a list bullet whose text is not drawn yet.
        if (/^\s*(-|\d+\.)\s*$/m.test(app.captureCharFrame())) blank++
        await Bun.sleep(PACE_MS)
      }
      const used = process.cpuUsage(cpu)
      return {
        ...stats(steps),
        // Mean step cost per 250 steps, to show growth as rows mount.
        buckets: Array.from({ length: Math.ceil(steps.length / 250) }, (_, i) => stats(steps.slice(i * 250, i * 250 + 250)).meanMs),
        moved: stats(moved),
        mounted: stats(mounted),
        stalled,
        blank,
        wallMs: Math.round(performance.now() - started),
        cpuMs: Math.round((used.user + used.system) / 1000),
      }
    }
    const top = () => app.captureCharFrame().includes("Scroll prompt 0:")
    // SCROLL_PROFILE=<file> samples the scroll up with the runtime's profiler and prints the heaviest functions.
    const inspector = process.env.SCROLL_PROFILE ? new Session() : undefined
    const post = (method: string, params?: object) =>
      new Promise<any>((resolve, reject) =>
        inspector!.post(method as "Profiler.start", params ?? {}, (error, result) => (error ? reject(error) : resolve(result))),
      )
    if (inspector) {
      inspector.connect()
      await post("Profiler.enable")
      await post("Profiler.setSamplingInterval", { interval: 200 })
      await post("Profiler.start")
    }
    const up = await run("up", UP, top)
    if (inspector) {
      const { profile } = await post("Profiler.stop")
      await Bun.write(process.env.SCROLL_PROFILE!, JSON.stringify(profile))
      inspector.disconnect()
      const self = new Map<string, number>()
      const counts = new Map<number, number>()
      for (const sample of profile.samples as number[]) counts.set(sample, (counts.get(sample) ?? 0) + 1)
      for (const node of profile.nodes as { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]) {
        const key = `${node.callFrame.functionName || "(anon)"} ${node.callFrame.url.split("/").slice(-2).join("/")}:${node.callFrame.lineNumber}`
        self.set(key, (self.get(key) ?? 0) + (counts.get(node.id) ?? 0))
      }
      const total = (profile.samples as number[]).length
      console.log(
        "[scroll-profile]\n" +
          [...self]
            .toSorted((a, b) => b[1] - a[1])
            .slice(0, 30)
            .map(([key, n]) => `${((100 * n) / total).toFixed(1)}% ${key}`)
            .join("\n"),
      )
    }
    const mounted = scroll.content.getChildren().length
    // Renderables under the mounted rows: what each frame's layout and paint walk.
    const count = (node: Renderable): number => 1 + node.getChildren().reduce((sum, child) => sum + count(child), 0)
    const renderables = scroll.content.getChildren().reduce((sum, child) => sum + count(child), 0)
    await app.waitForVisualIdle({ quietFrames: 3 })
    const down = await run("down", DOWN, () => false)
    const result = {
      turns: TURNS,
      pages: pages.length,
      reachedTop: top(),
      mountedChildren: mounted,
      renderables,
      renderablesPerRow: +(renderables / Math.max(1, mounted)).toFixed(1),
      up,
      down,
      highlight: { ...stats(highlights), mostWaiting },
    }
    client.highlightOnce = highlightOnce
    console.log(`[scroll-bench] ${JSON.stringify(result)}`)
    if (process.env.SCROLL_FRAME) await Bun.write(process.env.SCROLL_FRAME, app.captureCharFrame())
    expect(up.steps).toBeGreaterThan(0)
  },
  600_000,
)
