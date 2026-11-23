// Fork feature (synthetic-archived): every call that admits input into a session names who admits it, so an archived
// session's answer (refuse, hold, or the user's own) is a declared property of each source (SessionAdmission.Sources),
// never a call site's accident. A new upstream call that names no source fails here until it is classified.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { SessionAdmission } from "@opencode/core/session/admission"
import { classify, sites, unclassified } from "./fixture/admission-sites"

const root = path.resolve(import.meta.dir, "../../..")

describe("SessionAdmission sources", () => {
  test("every admission site in core and the server names its source or is counted in Exempt", () => {
    const found = Object.fromEntries([...unclassified(root)].map(([file, list]) => [file, list.length]))
    const declared = Object.fromEntries(
      Object.entries(SessionAdmission.Exempt).map(([file, entry]) => [file, entry.sites]),
    )
    expect(found).toEqual(declared)
  })

  test("every source is classified: it keeps its input (refused) or not (held)", () => {
    for (const [name, source] of Object.entries(SessionAdmission.Sources)) {
      expect(typeof source.keeps).toBe("boolean")
      expect(source.why.length).toBeGreaterThan(0)
      expect(SessionAdmission.rule(name as SessionAdmission.Source)).toBe(source.keeps ? "refuse" : "hold")
    }
    expect(SessionAdmission.rule(undefined)).toBe("user")
  })

  test("an unclassified new source is caught, a named or plugin one is not", () => {
    const text = [
      "yield* sessions.synthetic({ sessionID, text })",
      'yield* sessions.synthetic({ sessionID, text, source: "shell" })',
      'yield* sessions.synthetic({ sessionID, text, source: "nonsense" })',
      "yield* ctx.session.synthetic({ sessionID, text })",
      "yield* ctx.session\n  .prompt({ sessionID, text })",
      "yield* inbox.admit({ id, sessionID, item })",
    ].join("\n")
    expect(sites("new.ts", text).map(classify)).toEqual([
      undefined,
      "shell",
      undefined,
      "plugin (host)",
      "plugin (host)",
      undefined,
    ])
  })
})
