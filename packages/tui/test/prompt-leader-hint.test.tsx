import { expect, test } from "bun:test"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"

const HINT = "ctrl+x …"
const TIMEOUT = 400

async function open() {
  // Other app tests can leave a home draft in the process-wide stash.
  takeDraft(undefined)
  const setup = await createAppFixture({ config: { animations: false, leader: { timeout: TIMEOUT } } })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  expect(setup.captureCharFrame()).not.toContain(HINT)
  setup.mockInput.pressKey("x", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes(HINT))
  return setup
}

test("the composer shows the pending leader and clears it when the chord completes", async () => {
  await using setup = await open()
  setup.mockInput.pressKey("t")
  await setup.waitForFrame((frame) => !frame.includes(HINT))
  expect(setup.captureCharFrame()).not.toContain(HINT)
})

test("the composer clears the pending leader when Escape cancels it", async () => {
  await using setup = await open()
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes(HINT))
  expect(setup.captureCharFrame()).not.toContain(HINT)
})

test("the composer clears the pending leader when it times out", async () => {
  await using setup = await open()
  await Bun.sleep(TIMEOUT + 200)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain(HINT)
})
