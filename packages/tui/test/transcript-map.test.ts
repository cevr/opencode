import { expect, test } from "bun:test"
import type { SessionOutlineEntry } from "@opencode/client"
import { clock, completion, filter, rowMessage, rows, turns, work } from "../src/routes/session/transcript-map"

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
const entry = (id: string, type: SessionOutlineEntry["type"], time: number, rest: Partial<SessionOutlineEntry> = {}) =>
  ({ id, type, time, ...rest }) as SessionOutlineEntry

const outline: SessionOutlineEntry[] = [
  entry("msg_01", "user", at(16, 23, 50), { summary: "Ship the release tonight" }),
  entry("msg_02", "assistant", at(16, 23, 51), { summary: "Reading the release notes first.", tools: 3, thoughts: 1 }),
  entry("msg_03", "assistant", at(16, 23, 52), {
    completed: at(16, 23, 54),
    summary: "Shipped it.",
    tools: 1,
    thoughts: 1,
  }),
  entry("msg_04", "idle", at(16, 23, 55)),
  entry("msg_05", "synthetic", at(17, 3, 12), {
    summary: "Implementor finished · implementor fix-a r1",
    source: "subagent",
  }),
  // Model-facing only: the transcript hides it, so the map does too.
  entry("msg_06", "synthetic", at(17, 3, 12)),
  entry("msg_07", "assistant", at(17, 3, 13), { tools: 2 }),
  entry("msg_08", "idle", at(17, 3, 14)),
  entry("msg_09", "synthetic", at(17, 4, 0), { summary: "monitor w1 matched · CI green", source: "wake" }),
  entry("msg_10", "synthetic", at(17, 5, 0), { summary: "from Ergo root · done", source: "mail" }),
  entry("msg_11", "synthetic", at(17, 6, 0), { summary: "Queue check: 2 stale of 5 open" }),
  entry("msg_12", "model-switched", at(17, 6, 1)),
]

test("a session's outline reads as one collapsed line per turn", () => {
  const list = turns(outline)
  expect(list.map((turn) => [turn.id, turn.who, turn.gist, work(turn)])).toEqual([
    ["msg_01", "you", "Ship the release tonight", ""],
    // An agent run is one turn from its first step, named by its final text, its work counted across its steps.
    ["msg_02", "agent", "Shipped it.", "2 thoughts, 4 tools"],
    ["msg_05", "subagent", "Implementor finished · implementor fix-a r1", ""],
    // A run without text is its work alone.
    ["msg_07", "agent", "", "2 tools"],
    ["msg_09", "monitor", "monitor w1 matched · CI green", ""],
    ["msg_10", "message", "from Ergo root · done", ""],
    ["msg_11", "queue", "Queue check: 2 stale of 5 open", ""],
  ])
  // An agent run reads as when it ended, as the transcript's time under it does.
  expect(list[1]!.time).toBe(at(16, 23, 54))
  expect(work({ thoughts: 1, tools: 1 })).toBe("1 thought, 1 tool")
})

test("a turn's time reads as the transcript writes it", () => {
  expect(clock(at(17, 12, 2))).toMatch(/^12:02 PM [A-Z][A-Za-z+\-:\d]*$/)
  expect(clock(at(17, 9, 5))).toMatch(/^9:05 AM /)
})

test("a day label stands above each day's first turn", () => {
  const labels = rows(turns(outline)).flatMap((row) => (row.type === "day" ? [row.label] : []))
  expect(labels).toEqual(["Mon Nov 16", "Tue Nov 17"])
  expect(rows(turns(outline))[0]).toEqual({ type: "day", label: "Mon Nov 16" })
})

test("the map spaces turns as the transcript does, tighter: a blank line above each prompt and each day", () => {
  const extra: SessionOutlineEntry[] = [
    ...outline,
    entry("msg_13", "user", at(17, 6, 2), { summary: "And the docs?" }),
    entry("msg_14", "assistant", at(17, 6, 3), { summary: "Done." }),
  ]
  const shape = rows(turns(extra)).map((row) => (row.type === "turn" ? row.turn.id : row.type))
  expect(shape).toEqual([
    "day",
    "msg_01",
    "msg_02",
    "gap",
    "day",
    "msg_05",
    "msg_07",
    "msg_09",
    "msg_10",
    "msg_11",
    "gap",
    "msg_13",
    "msg_14",
  ])
})

test("a worker's stop notice reads as who, how it ended and its task; other notices are not one", () => {
  const list = turns(outline)
  expect(completion(list.find((turn) => turn.id === "msg_05")!)).toEqual({
    actor: "Implementor",
    state: "finished",
    task: "implementor fix-a r1",
  })
  expect(completion({ kind: "notice", source: "shell", gist: "Shell failed · bun test" })).toEqual({
    actor: "Shell",
    state: "failed",
    task: "bun test",
  })
  expect(completion(list.find((turn) => turn.id === "msg_11")!)).toBeUndefined()
  expect(completion(list.find((turn) => turn.id === "msg_01")!)).toBeUndefined()
})

test("a transcript row names its first message, a folded group by its first entry", () => {
  const part = (messageID: string) => ({ type: "part" as const, ref: { messageID, partID: "p" } })
  expect(rowMessage({ type: "message", messageID: "msg_a" })).toBe("msg_a")
  expect(
    rowMessage({
      type: "group",
      kind: "activity",
      pending: [],
      completed: true,
      size: 2,
      children: [
        { type: "entry", entry: part("msg_b") },
        { type: "entry", entry: part("msg_c") },
      ],
    } as never),
  ).toBe("msg_b")
  expect(rowMessage({ type: "turn-usage", messageIDs: ["msg_d"] })).toBe("msg_d")
})

test("a filter matches text, a time or a day", () => {
  const list = turns(outline)
  expect(filter(list, "release").map((turn) => turn.id)).toEqual(["msg_01"])
  expect(filter(list, "03:").map((turn) => turn.id)).toEqual(["msg_05", "msg_07"])
  expect(filter(list, "3:12 am").map((turn) => turn.id)).toEqual(["msg_05"])
  expect(filter(list, "Nov 16").map((turn) => turn.id)).toEqual(["msg_01", "msg_02"])
  expect(filter(list, "monitor ci").map((turn) => turn.id)).toEqual(["msg_09"])
  expect(filter(list, "")).toBe(list)
})
