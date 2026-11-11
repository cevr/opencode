/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { StartupLoading } from "../../src/component/startup-loading"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("the plugin loading notice leaves as soon as the plugins are loaded", async () => {
  await using temporary = await tmpdir()
  const [ready, setReady] = createSignal(false)
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <StartupLoading ready={ready} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 10 },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Loading plugins…"))
    const loaded = Date.now()
    setReady(true)
    await app.waitForFrame((frame) => !frame.includes("Loading plugins…") && !frame.includes("Finishing startup…"))
    // It used to stay up as "Finishing startup…" until three seconds after it appeared.
    expect(Date.now() - loaded).toBeLessThan(1000)
  } finally {
    app.renderer.destroy()
  }
})
