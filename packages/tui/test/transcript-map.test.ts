import { expect, test } from "bun:test"
import type { SessionOutlineEntry } from "@opencode/client"
import { filter, rows, turns, firstSentence } from "../src/routes/session/transcript-map"

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
const entry = (id: string, type: SessionOutlineEntry["type"], time: number, rest: Partial<SessionOutlineEntry> = {}) =>
  ({ id, type, time, ...rest }) as SessionOutlineEntry

const outline: SessionOutlineEntry[] = [
  entry("msg_01", "user", at(16, 23, 50), { text: "\n  Ship the release tonight\nwith notes" }),
  entry("msg_02", "assistant", at(16, 23, 51), { tools: 3 }),
  entry("msg_03", "assistant", at(16, 23, 52), { text: "Shipped it. The notes are in the PR.", tools: 1 }),
  entry("msg_04", "idle", at(16, 23, 53)),
  entry("msg_05", "synthetic", at(17, 3, 12), {
    text: "implementor fix-a r1",
    source: "subagent",
  }),
  // Model-facing only: the transcript hides it, so the map does too.
  entry("msg_06", "synthetic", at(17, 3, 12)),
  entry("msg_07", "assistant", at(17, 3, 13), { tools: 2 }),
  entry("msg_08", "idle", at(17, 3, 14)),
  entry("msg_09", "synthetic", at(17, 4, 0), { text: "monitor w1 matched · CI green", source: "wake" }),
  entry("msg_10", "synthetic", at(17, 5, 0), { text: "from Ergo root · done", source: "mail" }),
  entry("msg_11", "synthetic", at(17, 6, 0), { text: "Queue check: 2 stale of 5 open" }),
  entry("msg_12", "model-switched", at(17, 6, 1)),
]

test("a session's outline reads as one line per turn", () => {
  expect(turns(outline).map((turn) => [turn.id, turn.who, turn.gist])).toEqual([
    ["msg_01", "you", "Ship the release tonight"],
    // An agent run is one turn from its first step, named by its first sentence.
    ["msg_02", "agent", "Shipped it."],
    ["msg_05", "subagent", "implementor fix-a r1"],
    // A run without text is named by its tool calls.
    ["msg_07", "agent", "2 tool calls"],
    ["msg_09", "monitor", "monitor w1 matched · CI green"],
    ["msg_10", "message", "from Ergo root · done"],
    ["msg_11", "queue", "Queue check: 2 stale of 5 open"],
  ])
  expect(turns(outline)[1]!.tools).toBe(4)
})

test("a day label stands above each day's first turn", () => {
  const labels = rows(turns(outline)).flatMap((row) => (row.type === "day" ? [row.label] : []))
  expect(labels).toEqual(["Mon Nov 16", "Tue Nov 17"])
  expect(rows(turns(outline))[0]).toEqual({ type: "day", label: "Mon Nov 16" })
})

test("a filter matches text, a time or a day", () => {
  const list = turns(outline)
  expect(filter(list, "release").map((turn) => turn.id)).toEqual(["msg_01"])
  expect(filter(list, "03:").map((turn) => turn.id)).toEqual(["msg_05", "msg_07"])
  expect(filter(list, "Nov 16").map((turn) => turn.id)).toEqual(["msg_01", "msg_02"])
  expect(filter(list, "monitor ci").map((turn) => turn.id)).toEqual(["msg_09"])
  expect(filter(list, "")).toBe(list)
})

test("a first sentence ends at its stop, not inside a word", () => {
  expect(firstSentence("Version 1.2 is out. Next.")).toBe("Version 1.2 is out.")
  expect(firstSentence("No stop here")).toBe("No stop here")
})
