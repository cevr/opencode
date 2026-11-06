/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { PromptEscapeStatus } from "../../../src/component/prompt"
import type { EscapeIntent } from "../../../src/prompt/escape"

const text = RGBA.fromHex("#ffffff")
const subdued = RGBA.fromHex("#808080")
const warning = RGBA.fromHex("#fbbf24")

async function line(intent: EscapeIntent) {
  const app = await testRender(
    () => <PromptEscapeStatus intent={intent} text={text} subdued={subdued} warning={warning} />,
    { width: 40, height: 1 },
  )
  try {
    await app.renderOnce()
    return app.renderer.currentRenderBuffer.getSpanLines()[0]!.spans.filter((span) => span.text.trim())
  } finally {
    app.renderer.destroy()
  }
}

test("a cancel on offer counts down in the warning colour", async () => {
  const spans = await line({ type: "cancel", messageID: "msg_1", left: 3200 })
  expect(spans.map((span) => span.text).join("")).toContain("esc cancel and edit · 4s")
  expect(spans.every((span) => span.fg.equals(warning))).toBeTrue()
})

test("after the grace the hint reads esc interrupt, subdued", async () => {
  const spans = await line({ type: "interrupt" })
  expect(spans.map((span) => span.text).join("")).toContain("esc interrupt")
  expect(spans.some((span) => span.fg.equals(warning))).toBeFalse()
  expect(spans.some((span) => span.fg.equals(subdued))).toBeTrue()
})

test("a queued prompt reads esc edit queued", async () => {
  const spans = await line({ type: "pull", inboxID: "msg_2", delivery: "queue" })
  expect(spans.map((span) => span.text).join("")).toContain("esc edit queued")
})

test("nothing renders when Escape means nothing", async () => {
  expect(await line({ type: "none" })).toEqual([])
})
