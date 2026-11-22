/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { DialogThemeList } from "../../src/component/dialog-theme-list"
import { ConfigProvider, type Info, type Interface } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider, useThemes } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { onMount } from "solid-js"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

/** A small seeded generator, so a failing seed replays. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

/**
 * A config file behind a host whose saves each take a random time before they read and write it, as a
 * contended file lock grants them out of call order. `disk` is the file; `calls` counts the saves.
 */
const slowHost = (initial: Info, seed: number) => {
  const random = seeded(seed)
  const state = { disk: structuredClone(initial), calls: 0 }
  const host: Interface = {
    get: async () => structuredClone(state.disk),
    update: async (update) => {
      state.calls++
      await Bun.sleep(Math.floor(random() * 80))
      const draft = structuredClone(state.disk)
      update(draft)
      state.disk = draft
      return structuredClone(draft)
    },
  }
  return { host, state }
}

const renderDialog = async (host: Interface, initial: Info, directory: string) => {
  let themes!: ReturnType<typeof useThemes>
  function Probe() {
    themes = useThemes()
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogThemeList />))
    return null
  }
  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory} paths={{ state: directory }}>
        <ConfigProvider config={createTuiResolvedConfig(initial)} service={host}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <Probe />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitFor(() => themes !== undefined, WAIT)
  // The dialog is open once its list has rendered a frame.
  await app.waitForFrame((frame) => frame.includes("Themes"), WAIT)
  return { app, themes: () => themes }
}

/** Frames to wait under a loaded host. */
const WAIT = { maxPasses: 400 }

const START: Info = { theme: { name: "opencode" } }

// Typing in the list and moving through it previews themes; only the pick is saved. Each save takes a
// random time (seeded), so a preview saved late would land over the pick.
test("typing and moving preview in memory; the confirmed pick is the one the file holds, at 50 seeds", async () => {
  await using temporary = await tmpdir()
  const results: Array<{ seed: number; disk: string | undefined; saves: number }> = []
  for (let seed = 1; seed <= 50; seed++) {
    const { host, state } = slowHost(START, seed)
    const { app, themes } = await renderDialog(host, START, temporary.path)
    try {
      await app.mockInput.typeText("cur")
      app.mockInput.pressArrow("down")
      app.mockInput.pressArrow("up")
      for (const _ of "cur") app.mockInput.pressBackspace()
      await app.mockInput.typeText("opencode-classic")
      // The list previews its first match, the pick.
      await app.waitFor(() => themes().selected === "opencode-classic", WAIT)
      app.mockInput.pressEnter()
      // Every save done: the file ends with the pick.
      await Bun.sleep(120)
      results.push({ seed, disk: state.disk.theme?.name, saves: state.calls })
    } finally {
      app.renderer.destroy()
    }
  }
  expect(results.filter((each) => each.disk !== "opencode-classic" || each.saves !== 1)).toEqual([])
}, 120_000)

test("Esc after previewing restores the starting theme and saves nothing", async () => {
  await using temporary = await tmpdir()
  const { host, state } = slowHost(START, 7)
  const { app, themes } = await renderDialog(host, START, temporary.path)
  try {
    await app.mockInput.typeText("cur")
    app.mockInput.pressArrow("down")
    await app.waitFor(() => themes().selected !== "opencode", WAIT)
    app.mockInput.pressEscape()
    await app.waitFor(() => themes().selected === "opencode", WAIT)
    await Bun.sleep(120)
    expect({ disk: state.disk, saves: state.calls }).toEqual({ disk: START, saves: 0 })
  } finally {
    app.renderer.destroy()
  }
}, 30_000)
