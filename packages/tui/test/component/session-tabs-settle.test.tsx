/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { EMPTY_SESSION_TAB_STATUS, SessionTabs, type SessionTabsController } from "../../src/component/session-tabs"
import { ThemeProvider } from "../../src/context/theme"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

// The strip's motion runs on wall time (the spring's interval, the pulse's animation clock), so this watches it live.
const WATCH_MS = 1_500
// The spring that moves widths and selection takes about 200 ms; the unread glow's release alone took 900 ms.
const SETTLE_MS = 450

test("a switch between unread tabs leaves the horizontal strip still soon after", async () => {
  const [current, setCurrent] = createSignal("first")
  const controller = {
    tabs: () => [
      { sessionID: "first", title: "First session" },
      { sessionID: "second", title: "Second session" },
      { sessionID: "third", title: "Third session" },
    ],
    current,
    select: setCurrent,
    close() {},
    move() {},
    add() {},
    // Never viewed here (a terminal that reports no focus): every tab stays unread through the switches.
    status: () => ({ ...EMPTY_SESSION_TAB_STATUS, unread: "activity" as const }),
  } satisfies SessionTabsController

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ tabs: { mode: "on" } })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <box width="100%" height="100%">
              <SessionTabs controller={controller} animations />
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 4 },
  )

  const strip = () =>
    app
      .captureSpans()
      .lines[0]!.spans.map((span) => `${span.text}|${span.fg.buffer.join()}|${span.bg.buffer.join()}`)
      .join("\n")
  /** Watches the strip for WATCH_MS after `change`: the ms after it of the last frame that differed from the one before. */
  const lastChange = async (change: () => void) => {
    let previous = strip()
    let last = 0
    const started = performance.now()
    const onFrame = () => {
      const next = strip()
      if (next !== previous) last = performance.now() - started
      previous = next
    }
    app.renderer.on("frame", onFrame)
    change()
    while (performance.now() - started < WATCH_MS) await Bun.sleep(10)
    app.renderer.off("frame", onFrame)
    return last
  }

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("First") && frame.includes("Third"))
    await Bun.sleep(WATCH_MS)
    const settled = [await lastChange(() => setCurrent("second")), await lastChange(() => setCurrent("third"))]
    // Each switch drew (the selection moved), and the strip went still well before the old 900 ms.
    for (const ms of settled) {
      expect(ms).toBeGreaterThan(0)
      expect(ms).toBeLessThan(SETTLE_MS)
    }
  } finally {
    app.renderer.destroy()
  }
})
