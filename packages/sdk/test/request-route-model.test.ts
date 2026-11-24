// A bounded model of one Step's routing, checked against the real runner through the public SDK and plugin hooks
// (see fixture/route-host.ts). Every sequence of up to two attempt outcomes, each one of
//   fail    — an ordinary send that reached the provider and failed (HTTP 500), retried at once
//   refuse  — a typed refusal at the final send boundary: known not sent
//   defer   — a routing hold before anything is built
//   restart — a routing hold, with the host closed and reopened on the same database before it ends
// then an end: the send succeeds, or the Step is held and cancelled (in the same host, or in a host reopened during
// the hold), and a later host is opened to show the cancel won. From attempt 2 on, the routing hook always asks for
// the other provider; the model says where the host must send instead: a Step with a possible send stays on that
// provider, a Step proven unsent may move.
import { expect, test } from "bun:test"
import type { SessionRouteStep } from "@opencode/plugin/promise/session"
import { ALPHA, BETA, RESTART_NOTICE, count, fixture, settle, until, type Host } from "./fixture/route-host"

type Action = "fail" | "refuse" | "defer" | "restart"
type End = "send" | "cancel" | "reopen-cancel"
const ACTIONS: Action[] = ["fail", "refuse", "defer", "restart"]

const sequences = (length: number): Action[][] =>
  length === 0 ? [[]] : sequences(length - 1).flatMap((prefix) => ACTIONS.map((action) => [...prefix, action]))
const cases = [0, 1, 2]
  .flatMap(sequences)
  .flatMap((prefix) =>
    prefix.length <= 1
      ? (["send", "cancel", "reopen-cancel"] as const).map((end) => ({ prefix, end }))
      : [{ prefix, end: "send" as const }],
  )

/** What the host must do for a sequence: where each send goes, what each attempt's routing sees, and the outcome. */
const model = (prefix: Action[], end: End) => {
  let pinned: typeof ALPHA | undefined
  let previous: SessionRouteStep["previous"]
  let immediate = false
  let holds = 0
  const sends: string[] = []
  const seen: Array<SessionRouteStep["previous"]> = []
  const target = (attempt: number) => (attempt === 1 ? ALPHA : (pinned ?? BETA))
  prefix.forEach((action, index) => {
    const attempt = index + 1
    seen.push(previous)
    const model = target(attempt)
    if (action === "fail") {
      sends.push(model.providerID)
      pinned = model
      previous = { model, sent: true }
      return
    }
    if (action === "refuse") {
      if (immediate) holds++
      immediate = !immediate
      previous = pinned ? { model: pinned, sent: true } : { model, sent: false }
      return
    }
    // A hold before routing changes no send history.
    holds++
    immediate = false
  })
  seen.push(previous)
  if (end === "send") sends.push(target(prefix.length + 1).providerID)
  return { sends, seen, holds, outcome: end === "send" ? ("succeeded" as const) : ("interrupted" as const) }
}

for (const { prefix, end } of cases) {
  test(`step routing [${[...prefix, end].join(" > ")}] matches the model`, async () => {
    const expected = model(prefix, end)
    const fails = prefix.filter((action) => action === "fail").length
    await using f = await fixture(
      {
        resolve: (event) => {
          const attempt = event.step!.attempt
          if (attempt > 1) event.model = BETA
          const action = prefix[attempt - 1]
          if (action === "defer") event.defer = { reason: "model hold", until: 0 }
          if (action === "restart") event.defer = { reason: "held over a restart", until: Date.now() + 1_200 }
          if (attempt === prefix.length + 1 && end !== "send")
            event.defer = { reason: "held for cancel", until: Date.now() + 60_000 }
        },
        send: (event) => {
          if (event.step && prefix[event.step.attempt - 1] === "refuse") event.refuse = { reason: "model refusal" }
        },
      },
      (_sent, index) => (index < fails ? { status: 500 } : { text: "done" }),
    )
    const reached = (attempt: number) => until(() => f.resolves.some((entry) => entry.step.attempt === attempt), 8_000)
    const reopen = async (current: Host) => {
      await Bun.sleep(150)
      await current.close()
      return f.open()
    }
    let host = await f.open()
    const session = await host.session.create({ location: { directory: f.work } })
    const started = Date.now()
    await host.session.prompt({ sessionID: session.id, text: "modelled prompt" })
    for (const [index, action] of prefix.entries()) {
      if (action !== "restart") continue
      expect(await reached(index + 1)).toBe(true)
      host = await reopen(host)
    }
    if (end !== "send") {
      expect(await reached(prefix.length + 1)).toBe(true)
      if (end === "reopen-cancel") host = await reopen(host)
      await Bun.sleep(200)
      await host.session.interrupt({ sessionID: session.id })
    }
    // A reopened host resumes the Step in the background, so its idle wait alone could return before that starts.
    if (end === "send") expect(await until(() => f.sends.length === expected.sends.length, 15_000)).toBe(true)
    await settle(host, session.id, 15_000)
    if (end !== "send") {
      // The cancel won: a later host neither routes nor sends the Step again.
      const resolved = f.resolves.length
      host = await reopen(host)
      await Bun.sleep(1_200)
      expect(f.resolves.length).toBe(resolved)
    }
    // Each hold waits at least a second, so no sequence spins.
    if (end === "send") expect(Date.now() - started).toBeGreaterThanOrEqual(expected.holds * 1_000 - 50)
    expect(f.sends.map((sent) => sent.provider)).toEqual(expected.sends)
    for (const sent of f.sends) {
      expect(sent.session).toBe(session.id)
      expect(count(sent, "modelled prompt")).toBe(1)
      // A Step held over a restart sent nothing the model could have started on: no restart notice.
      expect(sent.body).not.toContain(RESTART_NOTICE)
    }
    const steps = f.resolves.map((entry) => entry.step)
    expect(new Set(steps.map((step) => step.id)).size).toBe(1)
    expect(steps.map((step) => step.attempt)).toEqual(expected.seen.map((_, index) => index + 1))
    expect(steps.map((step) => step.previous)).toEqual(expected.seen)
    expect((await host.session.get({ sessionID: session.id })).outcome).toBe(expected.outcome)
  }, 40_000)
}
