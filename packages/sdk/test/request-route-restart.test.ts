// Seams: the public Promise SDK and plugin hooks driving the real runner against loopback providers, across real host
// restarts on one database (see fixture/route-host.ts). Each assertion reads what reached the wire, when, and where.
import { expect, test } from "bun:test"
import { ALPHA, BETA, RESTART_NOTICE, count, fixture, settle, until } from "./fixture/route-host"

// A hold set by either arm survives a restart: the next host sends nothing before its deadline and then delivers the
// original prompt once, as the same Step, with no restart notice and no second policy decision.
for (const arm of ["resolve", "refuse"] as const) {
  test(`a ${arm} hold outlives a restart: nothing before its deadline, then the original prompt once`, async () => {
    let deadline = 0
    const hold = () => {
      // Long enough that the restart lands inside the hold even on a loaded host.
      deadline = Date.now() + 4_000
      return { reason: "held over restart", until: deadline }
    }
    await using f = await fixture(
      {
        // One decision, made once: a host that forgot it would send before the deadline.
        resolve: (event) => {
          if (arm === "resolve" && event.step!.attempt === 1) event.defer = hold()
        },
        send: (event) => {
          if (arm === "refuse" && event.step?.attempt === 1) event.refuse = hold()
        },
      },
      () => ({ text: "delivered" }),
    )
    const first = await f.open()
    const session = await first.session.create({ location: { directory: f.work } })
    await first.session.prompt({ sessionID: session.id, text: "survive restart" })
    expect(await until(() => deadline > 0, 4_000)).toBe(true)
    await Bun.sleep(200)
    await first.close()
    expect(Date.now()).toBeLessThan(deadline)
    expect(f.sends).toEqual([])

    const second = await f.open()
    expect(await until(() => f.sends.length > 0, deadline - Date.now() + 3_000)).toBe(true)
    await settle(second, session.id)
    // Nothing before the deadline, exactly one delivery after it, on the same session and Step.
    expect(f.sends.map((sent) => [sent.session, sent.provider, sent.at >= deadline])).toEqual([
      [session.id, "alpha", true],
    ])
    expect(count(f.sends[0]!, "survive restart")).toBe(1)
    expect(f.sends[0]!.body).not.toContain(RESTART_NOTICE)
    const steps = f.resolves.map((entry) => entry.step)
    expect(new Set(steps.map((step) => step.id)).size).toBe(1)
    expect(steps.map((step) => step.attempt)).toEqual([1, 2])
    expect(f.resolves.at(-1)!.at).toBeGreaterThanOrEqual(deadline)
    expect(f.refusals.length).toBe(arm === "refuse" ? 1 : 0)
    const transcript = JSON.stringify(await second.message.list({ sessionID: session.id, limit: 50 }))
    expect(transcript.split("survive restart").length - 1).toBe(1)
    expect(transcript).not.toContain(RESTART_NOTICE)
    expect((await second.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
  }, 30_000)
}

test("a subagent's held Step outlives a restart in its original native job", async () => {
  let parent = ""
  let deadline = 0
  await using f = await fixture(
    {
      resolve: (event) => {
        if (event.sessionID !== parent && event.step!.attempt === 1) {
          deadline = Date.now() + 4_000
          event.defer = { reason: "child held over restart", until: deadline }
        }
      },
    },
    (sent) => {
      if (sent.session !== parent) return { text: "child done" }
      // The parent's first request launches the child; every later one (its tool result, the child's report) ends.
      if (f.sends.filter((item) => item.session === parent).length === 1)
        return { tool: "subagent", input: { agent: "general", description: "Child work", prompt: "child task" } }
      return { text: "child launched" }
    },
  )
  const first = await f.open()
  const session = await first.session.create({ location: { directory: f.work } })
  parent = session.id
  await first.session.prompt({ sessionID: session.id, text: "start a child" })
  expect(await until(() => deadline > 0, 6_000)).toBe(true)
  await Bun.sleep(200)
  const before = await first.experimental.job.list({ sessionID: session.id, kind: "subagent" })
  expect(before.map((job) => job.status)).toEqual(["running"])
  const child = before[0]!.kind === "subagent" ? before[0]!.childSessionID : ""
  await first.close()
  const childSends = () => f.sends.filter((sent) => sent.session === child)
  expect(childSends()).toEqual([])

  const second = await f.open()
  // While the recovered child waits out its hold, the restart keeps the one native job it started in.
  await Bun.sleep(300)
  expect(Date.now()).toBeLessThan(deadline)
  const during = await second.experimental.job.list({ sessionID: session.id, kind: "subagent" })
  expect(during.map((job) => [job.id, job.status, job.kind === "subagent" ? job.childSessionID : undefined])).toEqual([
    [before[0]!.id, "running", child],
  ])
  expect(await until(() => childSends().length > 0, deadline - Date.now() + 4_000)).toBe(true)
  await settle(second, child)
  expect(childSends().map((sent) => [sent.provider, count(sent, "child task"), sent.at >= deadline])).toEqual([
    ["alpha", 1, true],
  ])
  expect(childSends()[0]!.body).not.toContain(RESTART_NOTICE)
  const childSteps = f.resolves.filter((entry) => entry.session === child).map((entry) => entry.step)
  expect(childSteps.map((step) => step.attempt)).toEqual([1, 2])
  expect(new Set(childSteps.map((step) => step.id)).size).toBe(1)
  // That job carried the child to its end: no second job and no new child session was started.
  expect(await second.experimental.job.list({ sessionID: session.id, kind: "subagent", status: "running" })).toEqual([])
  const children = (await second.session.list({ parentID: session.id })).data
  expect(children.map((item) => item.id)).toEqual([child])
  expect((await second.session.get({ sessionID: child })).outcome).toBe("succeeded")
}, 30_000)

test("a cancel during a recovered hold wins over every later host", async () => {
  await using f = await fixture(
    {
      resolve: (event) => {
        if (event.step!.attempt === 1) event.defer = { reason: "held long", until: Date.now() + 60_000 }
      },
    },
    () => ({ text: "never" }),
  )
  const first = await f.open()
  const session = await first.session.create({ location: { directory: f.work } })
  await first.session.prompt({ sessionID: session.id, text: "cancel me" })
  expect(await until(() => f.resolves.length > 0, 4_000)).toBe(true)
  await Bun.sleep(200)
  await first.close()
  const second = await f.open()
  await Bun.sleep(400)
  await second.session.interrupt({ sessionID: session.id })
  await settle(second, session.id)
  expect((await second.session.get({ sessionID: session.id })).outcome).toBe("interrupted")
  await second.close()
  const third = await f.open()
  await Bun.sleep(1_500)
  expect(f.sends).toEqual([])
  expect(f.resolves.map((entry) => entry.step.attempt)).toEqual([1])
  expect((await third.session.get({ sessionID: session.id })).outcome).toBe("interrupted")
}, 30_000)

// The round-3 verifier's sequence: an ordinary send fails on alpha, its retry is deferred, then the hook asks for
// beta. The prior send pins the Step to alpha, in one host and across a restart during the hold.
for (const restart of [false, true]) {
  test(`a send history pins the Step through a later hold${restart ? " and a restart" : ""}`, async () => {
    let held = 0
    await using f = await fixture(
      {
        resolve: (event) => {
          if (event.step!.attempt === 2) {
            held = Date.now() + (restart ? 3_000 : 1_000)
            event.defer = { reason: "one recheck", until: held }
          }
          if (event.step!.attempt >= 3) event.model = BETA
        },
      },
      (_sent, index) => (index === 0 ? { status: 500 } : { text: "recovered" }),
    )
    let host = await f.open()
    const session = await host.session.create({ location: { directory: f.work } })
    await host.session.prompt({ sessionID: session.id, text: "ordinary retry" })
    if (restart) {
      expect(await until(() => held > 0, 4_000)).toBe(true)
      await Bun.sleep(200)
      await host.close()
      host = await f.open()
    }
    expect(await until(() => f.sends.length >= 2, 8_000)).toBe(true)
    await settle(host, session.id)
    expect(f.sends.map((sent) => [sent.provider, count(sent, "ordinary retry")])).toEqual([
      ["alpha", 1],
      ["alpha", 1],
    ])
    expect(f.sends[1]!.at).toBeGreaterThanOrEqual(held)
    expect(f.resolves.map((entry) => [entry.step.attempt, entry.step.previous])).toEqual([
      [1, undefined],
      [2, { model: ALPHA, sent: true }],
      [3, { model: ALPHA, sent: true }],
    ])
    expect((await host.session.get({ sessionID: session.id })).model).toBeUndefined()
    expect((await host.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
  }, 30_000)
}

test("a Step proven unsent before a restart may still move providers after it", async () => {
  let deadline = 0
  await using f = await fixture(
    {
      resolve: (event) => {
        if (event.step!.previous && !event.step!.previous.sent) event.model = BETA
      },
      send: (event) => {
        if (event.step?.attempt === 1) {
          deadline = Date.now() + 3_000
          event.refuse = { reason: "alpha closed", until: deadline }
        }
      },
    },
    () => ({ text: "moved" }),
  )
  const first = await f.open()
  const session = await first.session.create({ location: { directory: f.work } })
  await first.session.prompt({ sessionID: session.id, text: "unsent" })
  expect(await until(() => deadline > 0, 4_000)).toBe(true)
  await Bun.sleep(200)
  await first.close()
  const second = await f.open()
  expect(await until(() => f.sends.length > 0, 6_000)).toBe(true)
  await settle(second, session.id)
  expect(f.sends.map((sent) => [sent.provider, count(sent, "unsent"), sent.at >= deadline])).toEqual([
    ["beta", 1, true],
  ])
  expect(f.resolves.map((entry) => [entry.step.attempt, entry.step.previous])).toEqual([
    [1, undefined],
    [2, { model: ALPHA, sent: false }],
  ])
}, 30_000)
