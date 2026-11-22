/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { Flock } from "@opencode/util/flock"
import { expect, test } from "bun:test"
import path from "path"
import { ConfigProvider, useConfig, type Info, type Interface } from "../src/config"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

/** A small seeded generator, so a failing seed replays. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

/**
 * A config file saved as the CLI saves it: read, change and write while holding the file's lock. The lock
 * polls with backoff, so contenders get it in no particular order; each save holds it a random time.
 */
const lockedHost = (directory: string, seed: number, fail?: (draft: Info) => boolean): Interface => {
  const file = path.join(directory, "cli.json")
  const random = seeded(seed)
  const read = async (): Promise<Info> => ((await Bun.file(file).exists()) ? await Bun.file(file).json() : {})
  return {
    get: read,
    update: async (update) => {
      const lease = await Flock.acquire(file, { dir: path.join(directory, "locks"), baseDelayMs: 2, maxDelayMs: 8 })
      try {
        await Bun.sleep(Math.floor(random() * 4))
        const draft = await read()
        update(draft)
        if (fail?.(draft)) throw new Error("disk full")
        await Bun.write(file, JSON.stringify(draft))
        return draft
      } finally {
        await lease.release()
      }
    },
  }
}

const renderConfig = async (host: Interface) => {
  let config!: ReturnType<typeof useConfig>
  function Probe() {
    config = useConfig()
    return null
  }
  const app = await testRender(() => (
    <ConfigProvider config={createTuiResolvedConfig({})} service={host}>
      <Probe />
    </ConfigProvider>
  ))
  return { app, config: () => config }
}

const NAMES = ["c", "cu", "cur", "cursor", "o", "op", "opencode", "opencode-classic"]

// The flock-order probe as a test: updates fired at once, as a theme list fires them, used to reach the
// lock in a random order, so an earlier one could land last. In call order, the last call wins every time.
test("updates fired at once are saved in call order: the last call wins on disk and in the store, at 50 seeds", async () => {
  const lost: Array<{ seed: number; disk: unknown; store: unknown }> = []
  for (let seed = 1; seed <= 50; seed++) {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "cli.json")
    const { app, config } = await renderConfig(lockedHost(directory.path, seed))
    try {
      await Promise.all(
        NAMES.map((name) =>
          config().update((draft) => {
            draft.theme = { ...draft.theme, name }
          }),
        ),
      )
      const disk = (await Bun.file(file).json()).theme?.name
      const store = config().data.theme.name
      if (disk !== "opencode-classic" || store !== "opencode-classic") lost.push({ seed, disk, store })
    } finally {
      app.renderer.destroy()
    }
  }
  expect(lost).toEqual([])
}, 60_000)

test("a failed save rejects its own caller once and the updates after it still run", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  const { app, config } = await renderConfig(lockedHost(directory.path, 3, (draft) => draft.theme?.name === "bad"))
  try {
    const set = (name: string) =>
      config().update((draft) => {
        draft.theme = { ...draft.theme, name }
      })
    const results = await Promise.allSettled([set("first"), set("bad"), set("last")])
    expect(results.map((each) => each.status)).toEqual(["fulfilled", "rejected", "fulfilled"])
    expect((await Bun.file(file).json()).theme.name).toBe("last")
    expect(config().data.theme.name).toBe("last")
  } finally {
    app.renderer.destroy()
  }
})
