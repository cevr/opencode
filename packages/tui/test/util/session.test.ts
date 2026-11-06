import { describe, expect, test } from "bun:test"
import { sessionActivity, sessionFamily } from "../../src/util/session"

describe("util.session", () => {
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })

  test("a session works while its turn runs, or while a shell it started or a session under it still works", () => {
    const sessions = [
      { id: "root" },
      { id: "run", parentID: "root" },
      { id: "shell", parentID: "root" },
      { id: "parent", parentID: "root" },
      { id: "grandchild", parentID: "parent" },
      { id: "done", parentID: "root" },
      { id: "done-child", parentID: "done" },
    ]
    const activity = sessionActivity(
      sessions,
      (id) => (id === "run" || id === "grandchild" ? "running" : "idle"),
      (id) => (id === "shell" ? 1 : 0),
    )
    expect(sessions.map((session) => [session.id, activity(session.id)])).toEqual([
      ["root", "waiting"],
      ["run", "running"],
      ["shell", "waiting"],
      ["parent", "waiting"],
      ["grandchild", "running"],
      ["done", undefined],
      ["done-child", undefined],
    ])
  })

  test("a cycle in the parents never loops", () => {
    const sessions = [
      { id: "a", parentID: "b" },
      { id: "b", parentID: "a" },
    ]
    expect(sessionActivity(sessions, () => "idle", () => 0)("a")).toBeUndefined()
    expect(sessionActivity(sessions, () => "idle", (id) => (id === "b" ? 1 : 0))("a")).toBe("waiting")
  })
})
