// Seams: the public Promise SDK and plugin hooks driving the real runner and the real restart sweep against loopback
// providers, across many real host reopenings on one database (see fixture/route-host.ts).
//
// A host's recovery budget (SessionRestart, ten resumes by default) bounds a turn that keeps dying while it runs. A
// boot that finds the turn's Step held has nothing running to resume: it only takes the wait back, so it is not
// charged. The charge comes when the recovered turn leaves the wait for runnable work, so a turn that dies after
// leaving its hold still stops at the cap.
import { expect, test } from "bun:test"
import { RESTART_NOTICE, count, fixture, settle, until, type Host } from "./fixture/route-host"

/** SessionRestart's default budget: a turn is resumed at most this many times before it is failed. */
const NATIVE_CAP = 10
const REOPENS = NATIVE_CAP + 2

type World = Awaited<ReturnType<typeof fixture>>

// Closes and reopens the host `times` times, each a full boot with its own recovery sweep, and checks the world after
// each one. Fails loudly if the hold's deadline would pass inside the loop, which would prove nothing.
const reopen = async (
  f: World,
  host: Host,
  times: number,
  deadline: number,
  check: (host: Host, n: number) => Promise<void>,
) => {
  for (let n = 1; n <= times; n++) {
    await host.close()
    host = await f.open()
    // Let the boot reach its claim recovery pass; nothing is due before the deadline.
    await Bun.sleep(200)
    expect({ reopen: n, beforeDeadline: Date.now() < deadline }).toEqual({ reopen: n, beforeDeadline: true })
    await check(host, n)
  }
  return host
}

test("a held prompt outlives more reopens than the recovery cap, then is delivered once on its original Step", async () => {
  let deadline = 0
  await using f = await fixture(
    {
      send: (event) => {
        if (event.step?.attempt !== 1) return
        deadline = Date.now() + 9_000
        event.refuse = { reason: "one scheduled hold", until: deadline }
      },
    },
    () => ({ text: "delivered" }),
  )
  let host = await f.open()
  const session = await host.session.create({ location: { directory: f.work } })
  await host.session.prompt({ sessionID: session.id, text: "keep the original prompt" })
  expect(await until(() => deadline > 0, 5_000)).toBe(true)
  await Bun.sleep(200)
  host = await reopen(f, host, REOPENS, deadline, async (host, n) => {
    const state = await host.session.get({ sessionID: session.id })
    expect({
      reopen: n,
      failed: state.outcome === "failed",
      sends: f.sends.length,
      refusals: f.refusals.length,
    }).toEqual({ reopen: n, failed: false, sends: 0, refusals: 1 })
  })

  expect(await until(() => f.sends.length > 0, deadline - Date.now() + 5_000)).toBe(true)
  await settle(host, session.id)
  expect(f.sends.map((sent) => [sent.session, sent.provider, sent.at >= deadline])).toEqual([
    [session.id, "alpha", true],
  ])
  expect(count(f.sends[0]!, "keep the original prompt")).toBe(1)
  expect(f.sends[0]!.body).not.toContain(RESTART_NOTICE)
  expect(f.refusals).toHaveLength(1)
  const steps = f.resolves.map((entry) => entry.step)
  expect(new Set(steps.map((step) => step.id)).size).toBe(1)
  expect(steps.map((step) => step.attempt)).toEqual([1, 2])
  const transcript = JSON.stringify(await host.message.list({ sessionID: session.id, limit: 50 }))
  expect(transcript.split("keep the original prompt").length - 1).toBe(1)
  expect(transcript).not.toContain(RESTART_NOTICE)
  expect((await host.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
}, 45_000)

test("a held subagent outlives more reopens than the recovery cap in its original native job", async () => {
  let parent = ""
  let deadline = 0
  await using f = await fixture(
    {
      resolve: (event) => {
        if (event.sessionID !== parent && event.step!.attempt === 1) {
          deadline = Date.now() + 9_000
          event.defer = { reason: "child held across many reopens", until: deadline }
        }
      },
    },
    (sent) => {
      if (sent.session !== parent) return { text: "child done" }
      if (f.sends.filter((item) => item.session === parent).length === 1)
        return { tool: "subagent", input: { agent: "general", description: "Child work", prompt: "child task" } }
      return { text: "child launched" }
    },
  )
  let host = await f.open()
  const session = await host.session.create({ location: { directory: f.work } })
  parent = session.id
  await host.session.prompt({ sessionID: session.id, text: "start a child" })
  expect(await until(() => deadline > 0, 6_000)).toBe(true)
  await Bun.sleep(200)
  const before = await host.experimental.job.list({ sessionID: session.id, kind: "subagent" })
  expect(before.map((job) => job.status)).toEqual(["running"])
  const child = before[0]!.kind === "subagent" ? before[0]!.childSessionID : ""
  const childSends = () => f.sends.filter((sent) => sent.session === child)
  host = await reopen(f, host, REOPENS, deadline, async (host, n) => {
    const jobs = await host.experimental.job.list({ sessionID: session.id, kind: "subagent" })
    expect({
      reopen: n,
      jobs: jobs.map((job) => [job.id, job.status, job.kind === "subagent" ? job.childSessionID : undefined]),
      sends: childSends().length,
    }).toEqual({ reopen: n, jobs: [[before[0]!.id, "running", child]], sends: 0 })
  })

  expect(await until(() => childSends().length > 0, deadline - Date.now() + 5_000)).toBe(true)
  await settle(host, child)
  expect(childSends().map((sent) => [sent.provider, count(sent, "child task"), sent.at >= deadline])).toEqual([
    ["alpha", 1, true],
  ])
  expect(childSends()[0]!.body).not.toContain(RESTART_NOTICE)
  const childSteps = f.resolves.filter((entry) => entry.session === child).map((entry) => entry.step)
  expect(childSteps.map((step) => step.attempt)).toEqual([1, 2])
  expect(new Set(childSteps.map((step) => step.id)).size).toBe(1)
  expect(await host.experimental.job.list({ sessionID: session.id, kind: "subagent", status: "running" })).toEqual([])
  expect((await host.session.list({ parentID: session.id })).data.map((item) => item.id)).toEqual([child])
  expect((await host.session.get({ sessionID: child })).outcome).toBe("succeeded")
}, 45_000)

test("a cancel after more reopens than the recovery cap still wins before anything is sent", async () => {
  await using f = await fixture(
    {
      resolve: (event) => {
        if (event.step!.attempt === 1) event.defer = { reason: "held long", until: Date.now() + 60_000 }
      },
    },
    () => ({ text: "never" }),
  )
  let host = await f.open()
  const session = await host.session.create({ location: { directory: f.work } })
  await host.session.prompt({ sessionID: session.id, text: "cancel me" })
  expect(await until(() => f.resolves.length > 0, 4_000)).toBe(true)
  await Bun.sleep(200)
  host = await reopen(f, host, REOPENS, Date.now() + 60_000, async (host, n) => {
    const state = await host.session.get({ sessionID: session.id })
    expect({ reopen: n, failed: state.outcome === "failed", sends: f.sends.length }).toEqual({
      reopen: n,
      failed: false,
      sends: 0,
    })
  })
  expect(await host.session.interrupt({ sessionID: session.id })).toMatchObject({ interrupted: true })
  await settle(host, session.id)
  expect((await host.session.get({ sessionID: session.id })).outcome).toBe("interrupted")
  await host.close()
  const after = await f.open()
  await Bun.sleep(1_000)
  expect(f.sends).toEqual([])
  expect(f.resolves.map((entry) => entry.step.attempt)).toEqual([1])
  expect((await after.session.get({ sessionID: session.id })).outcome).toBe("interrupted")
}, 45_000)

test("a hold that ends while the host is down is delivered once at the next boot, after reopens during it", async () => {
  let deadline = 0
  await using f = await fixture(
    {
      send: (event) => {
        if (event.step?.attempt !== 1) return
        deadline = Date.now() + 3_000
        event.refuse = { reason: "short hold", until: deadline }
      },
    },
    () => ({ text: "delivered" }),
  )
  let host = await f.open()
  const session = await host.session.create({ location: { directory: f.work } })
  await host.session.prompt({ sessionID: session.id, text: "deliver after the hold" })
  expect(await until(() => deadline > 0, 5_000)).toBe(true)
  await Bun.sleep(200)
  host = await reopen(f, host, 3, deadline, async () => {
    expect(f.sends).toEqual([])
  })
  // Down across the deadline: the next boot finds a hold that already ended.
  await host.close()
  await Bun.sleep(Math.max(0, deadline - Date.now()) + 300)
  host = await f.open()
  expect(await until(() => f.sends.length > 0, 5_000)).toBe(true)
  await settle(host, session.id)
  expect(f.sends.map((sent) => [sent.session, sent.provider, sent.at >= deadline])).toEqual([
    [session.id, "alpha", true],
  ])
  expect(count(f.sends[0]!, "deliver after the hold")).toBe(1)
  expect(f.sends[0]!.body).not.toContain(RESTART_NOTICE)
  expect(f.refusals).toHaveLength(1)
  expect(f.resolves.map((entry) => entry.step.attempt)).toEqual([1, 2])
  expect(new Set(f.resolves.map((entry) => entry.step.id)).size).toBe(1)
  expect((await host.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
}, 30_000)

// Every attempt that leaves the hold reaches the provider and is still in flight when the host goes down, so every
// later boot resumes a turn that was running. With `recovered`, the host is down across the hold's end: the first
// boot takes the wait back uncharged and is charged as the Step leaves it, so that crossing counts toward the cap
// (a charge that was dropped rather than deferred would allow one more resume and one more send).
for (const recovered of [false, true]) {
  test(`a turn that keeps dying after it left ${recovered ? "a recovered" : "its"} hold still stops at the recovery cap`, async () => {
    let deadline = 0
    await using f = await fixture(
      {
        send: (event) => {
          if (event.step?.attempt !== 1) return
          deadline = Date.now() + (recovered ? 2_500 : 0)
          event.refuse = { reason: "brief hold", until: deadline }
        },
      },
      () => ({ hang: true }),
    )
    let host = await f.open()
    const session = await host.session.create({ location: { directory: f.work } })
    await host.session.prompt({ sessionID: session.id, text: "dies in flight" })
    expect(await until(() => deadline > 0, 5_000)).toBe(true)
    if (recovered) {
      await Bun.sleep(200)
      await host.close()
      expect(Date.now()).toBeLessThan(deadline)
      expect(f.sends).toEqual([])
      host = await f.open()
    }
    // The Step leaves its hold and its attempt goes out, once.
    expect(await until(() => f.sends.length === 1, deadline - Date.now() + 6_000)).toBe(true)
    expect(f.sends[0]!.at).toBeGreaterThanOrEqual(deadline)
    // Resumes the budget still allows after the attempts made so far: the recovered crossing used one.
    const resumes = recovered ? NATIVE_CAP - 1 : NATIVE_CAP
    for (let n = 1; n <= resumes + 1; n++) {
      await host.close()
      host = await f.open()
      // Resumed within the budget, the turn runs its in-flight Step again; past it, the boot fails the turn.
      if (n <= resumes)
        expect({ reopen: n, resent: await until(() => f.sends.length === n + 1, 6_000) }).toEqual({
          reopen: n,
          resent: true,
        })
    }
    await settle(host, session.id)
    expect((await host.session.get({ sessionID: session.id })).outcome).toBe("failed")
    await Bun.sleep(300)
    // The first attempt plus one per resume the budget allowed; none after it was spent.
    expect(f.sends).toHaveLength(resumes + 1)
    expect(f.sends.every((sent) => sent.session === session.id && sent.provider === "alpha")).toBe(true)
    expect(f.refusals).toHaveLength(1)
    expect(new Set(f.resolves.map((entry) => entry.step.id)).size).toBe(1)
  }, 45_000)
}
