import { describe, expect, test } from "bun:test"
import { appendPrompt, emptyPrompt, type PromptInfo } from "../../src/prompt/history"
import { takeBack, type PendingItem } from "../../src/prompt/take-back"

const file = (name: string) => ({ mime: "image/png", filename: name, uri: `media:${name}` })

const setup = (items: ReadonlyArray<PendingItem>, options: { refuse?: string[]; unreadable?: string[] } = {}) => {
  const steps: string[] = []
  let composer: PromptInfo = { ...emptyPrompt(), text: "draft" }
  const host = {
    pending: () => items,
    restore: async (prompt: any): Promise<PromptInfo> => {
      steps.push(`restore ${prompt.text}`)
      if (options.unreadable?.includes(prompt.text)) throw new Error("gone")
      return { ...emptyPrompt(), text: prompt.text, files: prompt.files ?? [] }
    },
    cancel: async (_sessionID: string, inboxID: string) => {
      steps.push(`cancel ${inboxID}`)
      return !options.refuse?.includes(inboxID)
    },
    append: (_sessionID: string, prompt: PromptInfo, separator: string) => {
      steps.push("append")
      composer = appendPrompt(composer, prompt, "wcwidth", separator)
    },
    widthMethod: "wcwidth" as const,
  }
  return { host, steps, composer: () => composer }
}

const user = (id: string, text: string, files?: unknown[]): PendingItem => ({
  id,
  type: "user",
  payload: { text, files },
})

describe("takeBack", () => {
  test("puts every pending prompt in the composer, in order, joined by the separator, attachments and all", async () => {
    const { host, steps, composer } = setup([
      user("a", "one", [file("x.png")]),
      user("b", "two"),
      user("c", "three", [file("y.png")]),
    ])
    const result = await takeBack(host, { sessionID: "s", inboxIDs: ["a", "b", "c"], separator: "\n" })
    expect(result).toEqual({ taken: ["a", "b", "c"], left: [] })
    expect(composer().text).toBe("draft\none\ntwo\nthree")
    expect(composer().files?.map((item) => item.uri)).toEqual(["media:x.png", "media:y.png"])
    // Each prompt is read back before any cancel releases its blobs, and the composer is written once.
    expect(steps.slice(0, 3)).toEqual(["restore one", "restore two", "restore three"])
    expect(steps.filter((step) => step === "append")).toHaveLength(1)
  })

  test("a prompt the server did not cancel, an unreadable one and one no longer pending stay out of the composer", async () => {
    const { host, steps, composer } = setup([user("a", "one"), user("b", "two"), user("c", "three")], {
      refuse: ["b"],
      unreadable: ["three"],
    })
    const result = await takeBack(host, { sessionID: "s", inboxIDs: ["a", "b", "c", "gone"], separator: "\n" })
    expect(result).toEqual({ taken: ["a"], left: ["b", "c", "gone"] })
    expect(composer().text).toBe("draft\none")
    // An unreadable prompt is never cancelled: it stays waiting rather than being lost.
    expect(steps).not.toContain("cancel c")
  })

  test("a blank line separates them by default, as the host's undo appends", async () => {
    const { host, composer } = setup([user("a", "one"), user("b", "two")])
    await takeBack(host, { sessionID: "s", inboxIDs: ["a", "b"] })
    expect(composer().text).toBe("draft\n\none\n\ntwo")
  })

  test("nothing taken leaves the composer alone", async () => {
    const { host, steps, composer } = setup([user("a", "one")], { refuse: ["a"] })
    expect(await takeBack(host, { sessionID: "s", inboxIDs: ["a"] })).toEqual({ taken: [], left: ["a"] })
    expect(composer().text).toBe("draft")
    expect(steps).not.toContain("append")
  })
})
