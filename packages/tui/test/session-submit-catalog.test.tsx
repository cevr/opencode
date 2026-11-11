import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { json, worktree } from "./fixture/tui-client"

// A session in another directory than the TUI's: its location's agents and
// models load after the session opens (after a service restart they wait
// through the boot's 503s). The composer takes input meanwhile, so an Enter
// pressed then is kept and sent once they load, not dropped as "no agent" or
// "model unavailable".
test("a prompt submitted before the session location's catalog loads is sent once it loads", async () => {
  const other = `${worktree}/other`
  const sessionID = `ses_submit_catalog_${crypto.randomUUID()}`
  const location = { directory: other, project: { id: "project", directory: other, canonical: other } }
  const catalog = Promise.withResolvers<void>()
  const prompted = Promise.withResolvers<string>()
  const held: string[] = []
  await using app = await createAppFixture({
    width: 100,
    height: 30,
    args: { sessionID },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}`)
        return json({
          data: {
            id: sessionID,
            projectID: "project",
            title: "Catalog fixture",
            agent: "build",
            model: { providerID: "demo", id: "model" },
            location: { directory: other },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/prompt`) {
        prompted.resolve((await request.json()).text)
        return json({ data: {} })
      }
      if (url.searchParams.get("location[directory]") !== other) return undefined
      if (["/api/agent", "/api/model", "/api/provider", "/api/location"].includes(url.pathname)) {
        held.push(url.pathname)
        await catalog.promise
      }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
      return undefined
    },
  })
  await app.ready
  await app.waitFor(() => held.length > 0)
  await app.waitForFrame((frame) => frame.includes(other))

  await app.mockInput.typeText("sent once loaded")
  app.mockInput.pressEnter()
  await app.waitForVisualIdle({ quietFrames: 3 })
  // Still loading: nothing is sent yet, and the prompt stays in the composer.
  expect(Bun.peek.status(prompted.promise)).toBe("pending")
  expect(app.captureCharFrame()).toContain("sent once loaded")
  catalog.resolve()

  const sent = await Promise.race([prompted.promise, Bun.sleep(15_000).then(() => "never sent")])
  expect(sent).toBe("sent once loaded")
  const frame = await app.waitForFrame((frame) => frame.includes("sent once loaded"))
  expect(frame).not.toContain("Model unavailable")
}, 30_000)
