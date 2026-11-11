import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { json, worktree } from "./fixture/tui-client"

// A session in another directory than the TUI's: its location's agents and
// models load after the session opens, and after a service restart the
// location is cold, so its first catalogs are empty or partial until its
// plugins activate and `*.updated` events bring the rest. The composer takes
// input meanwhile, so an Enter pressed then is kept and sent once the
// session's agent and model resolve, not dropped as "no agent" or "model
// unavailable".
test.each(["loading", "cold"] as const)(
  "a prompt submitted while the session location's catalog is %s is sent once it resolves",
  async (state) => {
    const other = `${worktree}/other`
    const sessionID = `ses_submit_catalog_${crypto.randomUUID()}`
    const location = { directory: other, project: { id: "project", directory: other, canonical: other } }
    const catalog = Promise.withResolvers<void>()
    const prompted = Promise.withResolvers<string>()
    const held: string[] = []
    let activated = state === "loading"
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
          if (state === "loading") await catalog.promise
        }
        if (url.pathname === "/api/location") return json(location)
        // A cold location lists what has loaded so far: no agents, and none of the configured provider's models.
        if (url.pathname === "/api/agent")
          return json({
            location,
            data: activated ? [{ id: "build", mode: "primary", hidden: false, permissions: [] }] : [],
          })
        if (url.pathname === "/api/provider")
          return json({ location, data: activated ? [{ id: "demo", name: "Demo" }] : [] })
        if (url.pathname === "/api/model")
          return json({
            location,
            data: activated ? [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] : [],
          })
        return undefined
      },
    })
    await app.ready
    await app.waitFor(() => held.length > 0)
    await app.waitForFrame((frame) => frame.includes(other))
    if (state === "cold") await app.waitFor(() => held.includes("/api/agent") && held.includes("/api/model"))

    await app.mockInput.typeText("sent once loaded")
    app.mockInput.pressEnter()
    await app.waitForVisualIdle({ quietFrames: 3 })
    // Not resolved yet: nothing is sent, and the prompt stays in the composer.
    expect(Bun.peek.status(prompted.promise)).toBe("pending")
    expect(app.captureCharFrame()).toContain("sent once loaded")
    if (state === "loading") catalog.resolve()
    else {
      // The location's plugins activate: its catalogs announce themselves and are read again.
      activated = true
      for (const type of ["agent.updated", "provider.updated", "model.updated"] as const)
        app.events.emit({ id: `evt_${type}`, created: 0, type, data: {}, location: { directory: other } })
    }

    const sent = await Promise.race([prompted.promise, Bun.sleep(15_000).then(() => "never sent")])
    expect(sent).toBe("sent once loaded")
    const frame = await app.waitForFrame((frame) => frame.includes("sent once loaded"))
    expect(frame).not.toContain("Model unavailable")
  },
  30_000,
)
