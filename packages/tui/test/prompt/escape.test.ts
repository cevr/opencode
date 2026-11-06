import { describe, expect, test } from "bun:test"
import {
  DEFAULT_GRACE_MS,
  escapeIntent,
  escapeLabel,
  graceMs,
  lastSent,
  noteSent,
  secondsLeft,
} from "../../src/prompt/escape"

const base = {
  busy: true,
  draft: false,
  pending: [],
  latestUserID: "msg_b",
  sent: { messageID: "msg_b", at: 10_000 },
  now: 11_000,
  grace: DEFAULT_GRACE_MS,
} as const

describe("escapeIntent", () => {
  test("inside the grace after sending the latest prompt, Escape cancels it", () => {
    expect(escapeIntent(base)).toEqual({ type: "cancel", messageID: "msg_b", left: 4000 })
  })

  test("after the grace, Escape interrupts", () => {
    expect(escapeIntent({ ...base, now: 15_000 })).toEqual({ type: "interrupt" })
  })

  test("a prompt sent elsewhere, or not the latest, only interrupts", () => {
    expect(escapeIntent({ ...base, sent: undefined })).toEqual({ type: "interrupt" })
    expect(escapeIntent({ ...base, latestUserID: "msg_c" })).toEqual({ type: "interrupt" })
  })

  test("grace 0 always interrupts", () => {
    expect(escapeIntent({ ...base, now: 10_000, grace: 0 })).toEqual({ type: "interrupt" })
  })

  test("the newest pending prompt comes back whatever the grace", () => {
    const pending = [
      { id: "msg_q1", delivery: "queue" },
      { id: "msg_q2", delivery: "queue" },
    ] as const
    expect(escapeIntent({ ...base, pending, now: 60_000 })).toEqual({
      type: "pull",
      inboxID: "msg_q2",
      delivery: "queue",
    })
    expect(escapeIntent({ ...base, pending, busy: false })).toEqual({
      type: "pull",
      inboxID: "msg_q2",
      delivery: "queue",
    })
  })

  test("a draft in the composer leaves the session alone", () => {
    expect(escapeIntent({ ...base, draft: true })).toEqual({ type: "none" })
    expect(escapeIntent({ ...base, draft: true, pending: [{ id: "msg_q", delivery: "queue" }] })).toEqual({
      type: "none",
    })
  })

  test("an idle session with nothing pending ignores Escape", () => {
    expect(escapeIntent({ ...base, busy: false })).toEqual({ type: "none" })
  })
})

test("labels and the countdown", () => {
  expect(escapeLabel({ type: "cancel", messageID: "m", left: 4200 })).toBe("cancel and edit · 5s")
  expect(escapeLabel({ type: "cancel", messageID: "m", left: 100 })).toBe("cancel and edit · 1s")
  expect(escapeLabel({ type: "interrupt" })).toBe("interrupt")
  expect(escapeLabel({ type: "pull", inboxID: "m", delivery: "queue" })).toBe("edit queued")
  expect(escapeLabel({ type: "pull", inboxID: "m", delivery: "steer" })).toBe("cancel and edit")
  expect(escapeLabel({ type: "none" })).toBeUndefined()
  expect(secondsLeft(5000)).toBe(5)
})

test("graceMs reads the config", () => {
  expect(graceMs(undefined)).toBe(DEFAULT_GRACE_MS)
  expect(graceMs(0)).toBe(0)
  expect(graceMs(2500)).toBe(2500)
  expect(graceMs(-1)).toBe(0)
})

test("noteSent keeps the last prompt per session", () => {
  noteSent("ses_escape_a", "msg_1", 1)
  noteSent("ses_escape_a", "msg_2", 2)
  expect(lastSent("ses_escape_a")).toEqual({ messageID: "msg_2", at: 2 })
  expect(lastSent("ses_escape_b")).toBeUndefined()
})
