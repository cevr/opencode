import type { JobInfo, SessionMessageInfo } from "@opencode/client"
import { describe, expect, test } from "bun:test"
import { sessionActivity, sessionFamily, ownedJobs, scriptLabel } from "../../src/util/session"

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

test("ownedJobs follows a subagent job to its child when the child's parent is not loaded", () => {
  const parents: Record<string, string> = { child: "session" }
  const jobs: JobInfo[] = [
    { kind: "codemode", id: "cm_grandchild", sessionID: "grandchild", status: "running", time: { started: 1 } },
    {
      kind: "subagent",
      id: "sub_nested",
      sessionID: "child",
      childSessionID: "grandchild",
      agent: "general",
      description: "Nested",
      status: "running",
      time: { started: 1 },
    },
  ]
  expect(ownedJobs(jobs, "child", (id) => parents[id]).map((job) => job.id)).toEqual(["sub_nested"])
  expect(ownedJobs(jobs, "session", (id) => parents[id]).map((job) => job.id)).toEqual(["sub_nested"])
  expect(ownedJobs(jobs, "grandchild", (id) => parents[id]).map((job) => job.id)).toEqual([
    "cm_grandchild",
    "sub_nested",
  ])
})

test("scriptLabel names a script by its first line of code, then its title", () => {
  const job: JobInfo = { kind: "codemode", id: "cm_1", sessionID: "session", status: "running", time: { started: 1 } }
  const messages = [
    {
      id: "msg",
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "part",
          name: "execute",
          state: { status: "completed", input: { code: "\n  // Build both\nawait 1" }, metadata: { jobID: "cm_1" } },
        },
      ],
    },
  ] as unknown as SessionMessageInfo[]
  expect(scriptLabel(messages, job)).toBe("// Build both")
  expect(scriptLabel([], { ...job, title: "Build" })).toBe("Build")
  expect(scriptLabel([], job)).toBe("Script")
})
