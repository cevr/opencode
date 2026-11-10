/** @jsxImportSource @opentui/solid */
import type { OpenCodeEvent } from "@opencode/client"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onMount, Show, type JSX } from "solid-js"
import { CommandPaletteDialog } from "../../../src/component/command-palette"
import { DialogSessionRename } from "../../../src/component/dialog-session-rename"
import { DataProvider, useData, type FormWithLocation } from "../../../src/context/data"
import { ClientProvider } from "../../../src/context/client"
import { ThemeProvider } from "../../../src/context/theme"
import { Keymap } from "../../../src/context/keymap"
import { ConfigProvider } from "../../../src/config"
import { DialogProvider, useDialog, type DialogContext } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"

/** The form where the session route docks it (routes/session/index.tsx): below a transcript that gives way first, in a dock that gives way next. */
function Docked(props: { children: JSX.Element }) {
  return (
    <box height="100%" paddingBottom={1}>
      <box flexGrow={1} flexBasis={0} minHeight={0}>
        <text>transcript</text>
      </box>
      <box height={1} flexShrink={0} />
      <box flexShrink={1} minHeight={0}>
        <box flexShrink={0}>
          <text>tray</text>
        </box>
        {props.children}
      </box>
    </box>
  )
}

/** A form docked as the session docks it, in a `width` by `height` terminal. */
function mountDocked(root: string, width: number, height: number, fields: FormWithLocation["fields"]) {
  return mountForm(root, width, fields, height, undefined, undefined, undefined, true)
}

async function mountForm(
  root: string,
  width = 80,
  fields?: FormWithLocation["fields"],
  height = 20,
  clipboardText?: string,
  response?: { reply?: 404 | 409; cancel?: 404 | 409; syncFailure?: boolean },
  actions?: FormWithLocation["actions"],
  docked = false,
) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })

  const replies: unknown[] = []
  const cancellations: unknown[] = []
  const copied: string[] = []
  let terminal = false
  let formLists = 0
  const events = createEventStream()
  const config = createTuiResolvedConfig()
  const form = {
    id: "frm_test",
    sessionID: "ses_test",
    title: "Authorization required",
    ...(actions === undefined ? {} : { actions }),
    fields: fields ?? [
      {
        key: "authorization",
        type: "external",
        url: "https://example.com/authorize",
        title: "Authorize access",
      },
    ],
  } satisfies FormWithLocation
  const failure = (status: 404 | 409) => {
    terminal = true
    return json(
      {
        _tag: status === 404 ? "FormNotFoundError" : "FormAlreadySettledError",
        id: form.id,
        message: status === 404 ? `Form not found: ${form.id}` : `Form already settled: ${form.id}`,
      },
      { status },
    )
  }
  const transport = createFetch((url, request) => {
    if (url.pathname === "/api/session/ses_test/form" && request.method === "GET")
      return response?.syncFailure && formLists++ > 0
        ? json({ message: "Could not refresh forms" }, { status: 500 })
        : json({ data: terminal ? [] : [form] })
    if (url.pathname === "/api/session/ses_test/form/frm_test/reply")
      return request.json().then((answer) => {
        replies.push(answer)
        return response?.reply ? failure(response.reply) : new Response(null, { status: 204 })
      })
    if (url.pathname === "/api/session/ses_test/form/frm_test" && request.method === "DELETE") {
      cancellations.push(true)
      return response?.cancel ? failure(response.cancel) : new Response(null, { status: 204 })
    }
  }, events)
  const { FormPrompt } = await import("../../../src/routes/session/form")

  function CurrentForm() {
    const data = useData()
    onMount(() => void data.session.form.sync(form.sessionID))
    return (
      <Show when={data.session.form.list(form.sessionID)?.[0]} keyed fallback={<text>Composer ready</text>}>
        {(current) => <FormPrompt form={current} />}
      </Show>
    )
  }

  function Harness() {
    return (
      <TestTuiContexts
        directory={root}
        paths={{
          home: root,
          state,
          worktree: root,
        }}
        clipboard={{
          async read() {
            return clipboardText === undefined ? undefined : { data: clipboardText, mime: "text/plain" }
          },
          write(text) {
            copied.push(text)
            return Promise.resolve()
          },
        }}
      >
        <ConfigProvider config={config}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <DataProvider directory={process.cwd()}>
                <ThemeProvider mode="dark" source={emptyThemeSource}>
                  <ToastProvider>
                    <DialogProvider>
                      {docked ? (
                        <Docked>
                          <FormPrompt form={form} />
                        </Docked>
                      ) : response ? (
                        <CurrentForm />
                      ) : (
                        <FormPrompt form={form} />
                      )}
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width, height, kittyKeyboard: true })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Authorization required"))
  return { app, cancellations, copied, replies }
}

function mountRecoveringForm(root: string, response: { reply?: 404 | 409; cancel?: 404 | 409; syncFailure?: boolean }) {
  return mountForm(
    root,
    80,
    [{ key: "target", type: "string", options: [{ value: "staging", label: "Staging" }] }],
    20,
    undefined,
    response,
  )
}

test("restores the composer when terminal-form revalidation fails", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountRecoveringForm(tmp.path, { reply: 404, syncFailure: true })
  try {
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("Composer ready"))

    expect(prompt.replies).toHaveLength(1)
  } finally {
    prompt.app.renderer.destroy()
  }
})

for (const status of [404, 409] as const) {
  test(`restores the composer after a terminal ${status} reply`, async () => {
    await using tmp = await tmpdir()
    const prompt = await mountRecoveringForm(tmp.path, { reply: status })
    try {
      prompt.app.mockInput.pressEnter()
      await prompt.app.waitForFrame((frame) => frame.includes("Composer ready"))

      expect(prompt.replies).toHaveLength(1)
      expect(prompt.app.captureCharFrame()).not.toContain("Form not found")
      expect(prompt.app.captureCharFrame()).not.toContain("Form already settled")
    } finally {
      prompt.app.renderer.destroy()
    }
  })

  test(`restores the composer after a terminal ${status} cancellation`, async () => {
    await using tmp = await tmpdir()
    const prompt = await mountRecoveringForm(tmp.path, { cancel: status })
    try {
      prompt.app.mockInput.pressEscape()
      await prompt.app.waitForFrame((frame) => frame.includes("Composer ready"))

      expect(prompt.cancellations).toHaveLength(1)
      expect(prompt.app.captureCharFrame()).not.toContain("Form not found")
      expect(prompt.app.captureCharFrame()).not.toContain("Form already settled")
    } finally {
      prompt.app.renderer.destroy()
    }
  })
}

test("requires explicit acknowledgement before submitting an external field", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path)
  try {
    prompt.app.mockInput.pressKey("right")
    await prompt.app.waitForFrame((frame) => frame.includes("(acknowledgement required)"))
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("External action must be acknowledged"))
    expect(prompt.replies).toEqual([])

    prompt.app.mockInput.pressKey("left")
    prompt.app.mockInput.pressKey("c")
    await prompt.app.waitForFrame((frame) => frame.includes("press enter to confirm"))
    expect(prompt.copied).toEqual(["https://example.com/authorize"])
    expect(prompt.replies).toEqual([])

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("Acknowledged"))
    expect(prompt.replies).toEqual([])

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { authorization: true } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("includes external acknowledgements in progress", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 32)
  try {
    expect(prompt.app.captureCharFrame()).toContain("0/1")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("shows a compact confirmation summary", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "targets",
      type: "multiselect",
      options: [{ value: "staging", label: "Staging" }],
      default: ["staging"],
    },
  ])
  try {
    prompt.app.mockInput.pressArrow("right")
    await prompt.app.waitForFrame((frame) => frame.includes("enter submit"))

    const frame = prompt.app.captureCharFrame()
    expect(frame).not.toContain("Review")
    expect(frame).not.toContain("Submit answers")

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { targets: ["staging"] } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("confirmation fits wrapped answers before offering scroll", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(
    tmp.path,
    48,
    [
      {
        key: "targets",
        title: "Include",
        type: "multiselect",
        options: [
          {
            value: "a very long selected deliverable that wraps",
            label: "A very long selected deliverable that wraps",
          },
        ],
        default: ["a very long selected deliverable that wraps"],
      },
      {
        key: "priority",
        title: "Priority",
        type: "multiselect",
        options: [{ value: "now", label: "Now" }],
        default: ["now"],
      },
    ],
    40,
  )
  try {
    expect(prompt.app.captureCharFrame()).toContain("Include  Priority  Submit")
    prompt.app.mockInput.pressArrow("right")
    prompt.app.mockInput.pressArrow("right")
    await prompt.app.waitForFrame((frame) => frame.includes("Priority: Now") && frame.includes("enter submit"))

    const frame = prompt.app.captureCharFrame()
    expect(frame).not.toContain("↑↓ scroll")
    const lines = frame.split("\n")
    expect(lines.findIndex((line) => line.includes("enter submit"))).toBeLessThan(20)
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("pasting on a custom choice opens its editor without submitting", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "target",
      type: "string",
      options: [{ value: "staging", label: "Staging" }],
      custom: true,
    },
  ])
  try {
    await prompt.app.mockInput.pasteBracketedText("production\nwest")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "production\nwest")

    await prompt.app.waitForFrame((frame) => frame.includes("production"))
    expect(prompt.app.captureCharFrame()).not.toContain("Type your own answer")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("pasting in an active custom editor inserts at the cursor", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "target",
      type: "string",
      options: [{ value: "staging", label: "Staging" }],
      custom: true,
    },
  ])
  try {
    prompt.app.mockInput.pressArrow("down")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor !== null)
    await prompt.app.mockInput.typeText("prodwest")
    const editor = prompt.app.renderer.currentFocusedEditor
    if (editor) editor.cursorOffset = 4

    await prompt.app.mockInput.pasteBracketedText("uction ")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "production west")
    await prompt.app.mockInput.typeText("!")

    expect(prompt.app.renderer.currentFocusedEditor?.plainText).toBe("production !west")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("clipboard shortcut opens a custom choice editor without submitting", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(
    tmp.path,
    80,
    [
      {
        key: "target",
        type: "string",
        options: [{ value: "staging", label: "Staging" }],
        custom: true,
      },
    ],
    20,
    "production\nwest",
  )
  try {
    prompt.app.mockInput.pressKey("v", { ctrl: true })
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "production\nwest")

    await prompt.app.waitForFrame((frame) => frame.includes("production"))
    expect(prompt.app.captureCharFrame()).not.toContain("Type your own answer")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("typing a custom multiselect answer selects it before commit", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "targets",
      type: "multiselect",
      options: [{ value: "staging", label: "Staging" }],
      custom: true,
      minItems: 1,
    },
  ])
  try {
    prompt.app.mockInput.pressArrow("down")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor !== null)
    await prompt.app.mockInput.typeText("production")
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] production"))

    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("up leaves a custom editor only from its first visual line", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "targets",
      type: "multiselect",
      options: [{ value: "staging", label: "Staging" }],
      custom: true,
    },
  ])
  try {
    prompt.app.mockInput.pressArrow("down")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor !== null)
    const editor = prompt.app.renderer.currentFocusedEditor
    editor?.setText("production\nwest")
    if (editor) editor.cursorOffset = editor.plainText.length
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.visualCursor.visualRow === 1)

    prompt.app.mockInput.pressArrow("up")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.visualCursor.visualRow === 0)
    expect(prompt.app.renderer.currentFocusedEditor).not.toBeNull()

    prompt.app.mockInput.pressArrow("up")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor === null)
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] Staging"))
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("typing on the highlighted custom option opens it without losing burst input", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "targets",
      type: "multiselect",
      options: [{ value: "staging", label: "Staging" }],
      custom: true,
    },
  ])
  try {
    prompt.app.mockInput.pressArrow("down")
    await prompt.app.mockInput.typeText("production target")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "production target")
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] production target"))

    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

const twoTargets = [
  { value: "staging", label: "Staging" },
  { value: "production", label: "Production" },
]

test("letters on an option row do nothing, and on the custom row they start the custom answer", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [{ key: "target", type: "string", options: twoTargets, custom: true }])
  try {
    await prompt.app.mockInput.typeText("west")
    await Bun.sleep(50)
    expect(prompt.app.renderer.currentFocusedEditor).toBeNull()
    expect(prompt.app.captureCharFrame()).toContain("3. Type your own answer")
    expect(prompt.replies).toEqual([])

    prompt.app.mockInput.pressArrow("down")
    prompt.app.mockInput.pressArrow("down")
    await prompt.app.mockInput.typeText("west 2")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "west 2")
    await prompt.app.waitForFrame((frame) => frame.includes("3. west 2"))
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a digit selects the choice it numbers", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [{ key: "target", type: "string", options: twoTargets, custom: true }])
  try {
    prompt.app.mockInput.pressKey("2")
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { target: "production" } }])
    expect(prompt.app.renderer.currentFocusedEditor).toBeNull()
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a digit past the choices does nothing on an option row", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [{ key: "target", type: "string", options: twoTargets, custom: true }])
  try {
    prompt.app.mockInput.pressKey("4")
    await Bun.sleep(50)
    expect(prompt.app.renderer.currentFocusedEditor).toBeNull()
    expect(prompt.app.captureCharFrame()).toContain("3. Type your own answer")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a digit toggles a multiselect choice, and typing on the custom row then opens the custom answer", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    { key: "targets", type: "multiselect", options: twoTargets, custom: true },
  ])
  try {
    prompt.app.mockInput.pressKey("2")
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] Production"))
    prompt.app.mockInput.pressKey("2")
    await prompt.app.waitForFrame((frame) => frame.includes("[ ] Production"))
    prompt.app.mockInput.pressKey("1")
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] Staging"))

    prompt.app.mockInput.pressArrow("up")
    await prompt.app.mockInput.typeText("eu1")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "eu1")
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] eu1"))
    const frame = prompt.app.captureCharFrame()
    expect(frame).toContain("[✓] Staging")
    expect(frame).toContain("[ ] Production")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("typing on a choice question without custom answers ignores letters and keeps digits", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [{ key: "target", type: "string", options: twoTargets }])
  try {
    await prompt.app.mockInput.typeText("xyz")
    await Bun.sleep(50)
    expect(prompt.app.renderer.currentFocusedEditor).toBeNull()
    expect(prompt.app.captureCharFrame()).not.toContain("xyz")
    expect(prompt.replies).toEqual([])

    prompt.app.mockInput.pressKey("2")
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { target: "production" } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("n on an option opens a note, and enter keeps the option chosen with its note", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [{ key: "target", type: "string", options: twoTargets, custom: true }])
  try {
    await prompt.app.waitForFrame((frame) => frame.includes("n notes"))
    prompt.app.mockInput.pressArrow("down")
    prompt.app.mockInput.pressKey("n")
    await prompt.app.mockInput.typeText("keep SQLite for tests")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "keep SQLite for tests")
    await prompt.app.waitForFrame((frame) => frame.includes("enter save note") && frame.includes("esc discard"))
    expect(prompt.app.captureCharFrame()).not.toContain("Production ✓")

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor === null)
    await prompt.app.waitForFrame(
      (frame) => frame.includes("Production ✓") && frame.includes("note: keep SQLite for tests"),
    )
    expect(prompt.replies).toEqual([])

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { target: "production (note: keep SQLite for tests)" } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("escape in a note discards the edit and leaves the choice as it was", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [{ key: "target", type: "string", options: twoTargets, custom: true }])
  try {
    prompt.app.mockInput.pressKey("n")
    await prompt.app.mockInput.typeText("draft")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "draft")
    prompt.app.mockInput.pressEscape()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor === null)
    await prompt.app.waitForFrame((frame) => frame.includes("n notes"))
    const frame = prompt.app.captureCharFrame()
    expect(frame).not.toContain("draft")
    expect(frame).not.toContain("Staging ✓")
    expect(prompt.cancellations).toEqual([])

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { target: "staging" } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("notes on multiselect options select them, never uncheck them, and ride in the answer", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    { key: "targets", type: "multiselect", options: twoTargets, custom: true },
  ])
  try {
    prompt.app.mockInput.pressKey("n")
    await prompt.app.mockInput.typeText("eu only")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "eu only")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] Staging") && frame.includes("note: eu only"))

    prompt.app.mockInput.pressKey("n")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "eu only")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor === null)
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] Staging") && frame.includes("note: eu only"))

    prompt.app.mockInput.pressKey("2")
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] Production"))
    prompt.app.mockInput.pressArrow("right")
    await prompt.app.waitForFrame((frame) => frame.includes("Staging (note: eu only), Production"))

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { targets: ["staging (note: eu only)", "production"] } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a choice without custom answers offers no notes", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [{ key: "target", type: "string", options: twoTargets }])
  try {
    expect(prompt.app.captureCharFrame()).not.toContain("n notes")
    prompt.app.mockInput.pressKey("n")
    await Bun.sleep(50)
    expect(prompt.app.renderer.currentFocusedEditor).toBeNull()

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { target: "staging" } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("enter on an empty custom multiselect option clearly enters editing", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "targets",
      type: "multiselect",
      options: [{ value: "staging", label: "Staging" }],
      custom: true,
      minItems: 1,
    },
  ])
  try {
    prompt.app.mockInput.pressArrow("down")
    await prompt.app.waitForFrame((frame) => frame.includes("enter edit"))

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor !== null)
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] Type your own answer") && frame.includes("enter done"))
    expect(prompt.app.captureCharFrame()).toContain("esc close")
    expect(prompt.app.captureCharFrame()).not.toContain("↑↓ select")

    prompt.app.mockInput.pressEscape()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor === null)
    await prompt.app.waitForFrame((frame) => frame.includes("[ ] Type your own answer"))

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor !== null)
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor === null)
    await prompt.app.waitForFrame((frame) => frame.includes("[ ] Type your own answer"))
    expect(prompt.app.captureCharFrame()).not.toContain("Select at least")

    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("defers multiselect validation until submission", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "targets",
      type: "multiselect",
      options: [{ value: "staging", label: "Staging" }],
      required: true,
      minItems: 1,
    },
    {
      key: "priority",
      type: "multiselect",
      options: [{ value: "now", label: "Now" }],
    },
  ])
  try {
    prompt.app.mockInput.pressEnter()
    prompt.app.mockInput.pressEnter()
    prompt.app.mockInput.pressArrow("right")
    await prompt.app.waitForFrame((frame) => frame.includes("[ ] Now"))
    expect(prompt.app.captureCharFrame()).not.toContain("Select at least")

    prompt.app.mockInput.pressArrow("right")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("Select at least"))
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("submits an optional empty multiselect as an omitted answer", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "targets",
      type: "multiselect",
      options: [{ value: "staging", label: "Staging" }],
      minItems: 1,
    },
    {
      key: "priority",
      type: "multiselect",
      options: [{ value: "now", label: "Now" }],
      default: ["now"],
    },
  ])
  try {
    prompt.app.mockInput.pressEnter()
    prompt.app.mockInput.pressEnter()
    prompt.app.mockInput.pressArrow("right")
    prompt.app.mockInput.pressArrow("right")
    prompt.app.mockInput.pressEnter()

    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { priority: ["now"] } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("typing a custom single-select answer selects it without submitting", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "target",
      type: "string",
      options: [{ value: "staging", label: "Staging" }],
      custom: true,
    },
  ])
  try {
    prompt.app.mockInput.pressArrow("down")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor !== null)
    await prompt.app.mockInput.typeText("production")
    await prompt.app.waitForFrame((frame) => frame.includes("production"))

    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("committing a custom multiselect answer keeps one editable custom row", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "targets",
      type: "multiselect",
      options: [{ value: "staging", label: "Staging" }],
      custom: true,
    },
  ])
  try {
    await prompt.app.mockInput.pasteBracketedText("production")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "production")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("2. [✓] production"))

    const frame = prompt.app.captureCharFrame()
    expect(frame).not.toContain("Type your own answer")
    expect(frame).not.toContain("3.")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("text fields retain default paste behavior", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [{ key: "notes", type: "string" }])
  try {
    await prompt.app.mockInput.pasteBracketedText("normal paste")

    expect(prompt.app.renderer.currentFocusedEditor?.plainText).toBe("normal paste")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("ctrl+c clears a text field before cancelling its form", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [{ key: "notes", type: "string" }])

  try {
    await prompt.app.mockInput.typeText("draft answer")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "draft answer")

    prompt.app.mockInput.pressKey("c", { ctrl: true })
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "")
    expect(prompt.cancellations).toEqual([])

    prompt.app.mockInput.pressKey("c", { ctrl: true })
    await prompt.app.waitFor(() => prompt.cancellations.length === 1)
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("pasting on a choice without custom answers does not open an editor", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "target",
      type: "string",
      options: [{ value: "staging", label: "Staging" }],
    },
  ])
  try {
    await prompt.app.mockInput.pasteBracketedText("production")

    expect(prompt.app.renderer.currentFocusedEditor).toBeNull()
    expect(prompt.app.captureCharFrame()).not.toContain("production")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("space toggles the selected multiselect option", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "targets",
      type: "multiselect",
      options: [
        { value: "staging", label: "Staging" },
        { value: "production", label: "Production" },
      ],
    },
  ])
  try {
    prompt.app.mockInput.pressKey(" ")
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] Staging"))
    expect(prompt.replies).toEqual([])

    prompt.app.mockInput.pressKey(" ")
    await prompt.app.waitForFrame((frame) => frame.includes("[ ] Staging"))
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("keeps a visible space between a multiselect marker and wrapped label", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 58, [
    {
      key: "targets",
      type: "multiselect",
      options: [
        {
          value: "responsive verification across narrow and wide terminal layouts",
          label: "Responsive verification across narrow and wide terminal layouts",
        },
      ],
      default: ["responsive verification across narrow and wide terminal layouts"],
    },
  ])
  try {
    expect(prompt.app.captureCharFrame()).toContain("[✓] Responsive verification")
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("space activates the custom multiselect option", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "targets",
      type: "multiselect",
      options: [{ value: "staging", label: "Staging" }],
      custom: true,
    },
  ])
  try {
    prompt.app.mockInput.pressArrow("down")
    prompt.app.mockInput.pressKey(" ")

    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor !== null)
    await prompt.app.waitForFrame((frame) => frame.includes("[✓] Type your own answer"))
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("space does not select a single-choice option", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [
    {
      key: "target",
      type: "string",
      options: [{ value: "staging", label: "Staging" }],
    },
  ])
  try {
    prompt.app.mockInput.pressKey(" ")
    expect(prompt.app.captureCharFrame()).not.toContain("Staging ✓")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

const dismiss = [{ key: "ctrl+x", label: "dismiss", value: "test:dismiss", mark: "dismissed" }]
const twoQuestions: FormWithLocation["fields"] = [
  {
    key: "first",
    type: "string",
    title: "First",
    description: "Which target first?",
    options: twoTargets,
    custom: true,
  },
  {
    key: "second",
    type: "string",
    title: "Second",
    description: "Which target next?",
    options: twoTargets,
    custom: true,
  },
]

test("a form action answers the field on screen with its value and moves on; pressed again it undoes", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 100, twoQuestions, 24, undefined, undefined, dismiss)
  try {
    await prompt.app.waitForFrame((frame) => frame.includes("ctrl+x dismiss"))
    prompt.app.mockInput.pressKey("x", { ctrl: true })
    await prompt.app.waitForFrame((frame) => frame.includes("Which target next?"))
    expect(prompt.replies).toEqual([])
    // ctrl+x is the default leader, and <leader>q dismisses the form: the action took the key, so q does not.
    prompt.app.mockInput.pressKey("q")
    await Bun.sleep(50)
    expect(prompt.cancellations).toEqual([])

    // Back on the first: marked, and the same key clears the mark.
    prompt.app.mockInput.pressArrow("left")
    await prompt.app.waitForFrame((frame) => frame.includes("✓ dismissed · ctrl+x again undoes"))
    prompt.app.mockInput.pressKey("x", { ctrl: true })
    await prompt.app.waitForFrame((frame) => !frame.includes("✓ dismissed"))
    expect(prompt.app.captureCharFrame()).toContain("Which target first?")

    // Dismissed again, the next key reaches the second question: the leader did not take it.
    prompt.app.mockInput.pressKey("x", { ctrl: true })
    await prompt.app.waitForFrame((frame) => frame.includes("Which target next?"))
    prompt.app.mockInput.pressKey("2")
    await prompt.app.waitForFrame((frame) => frame.includes("First: dismissed"))
    expect(prompt.app.captureCharFrame()).toContain("Second: Production")
    expect(prompt.app.captureCharFrame()).not.toContain("ctrl+x dismiss")

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { first: "test:dismiss", second: "production" } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a form action on a one-question form replies at once, from the custom answer's editor too", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(
    tmp.path,
    100,
    [{ key: "target", type: "string", options: twoTargets, custom: true }],
    20,
    undefined,
    undefined,
    dismiss,
  )
  try {
    prompt.app.mockInput.pressArrow("down")
    prompt.app.mockInput.pressArrow("down")
    await prompt.app.mockInput.typeText("eu1")
    await prompt.app.waitFor(() => prompt.app.renderer.currentFocusedEditor?.plainText === "eu1")
    prompt.app.mockInput.pressKey("x", { ctrl: true })
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { target: "test:dismiss" } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a form without actions shows no action key", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 100, twoQuestions, 24)
  try {
    await prompt.app.waitForFrame((frame) => frame.includes("Which target first?"))
    expect(prompt.app.captureCharFrame()).not.toContain("ctrl+x")
  } finally {
    prompt.app.renderer.destroy()
  }
})

// A question taller than the terminal: a phone-sized pane must still reach all of it.
const sixtyLines = Array.from({ length: 60 }, (_, index) => `line ${index + 1} of the question`).join("\n")
/** The PageDown key as a terminal sends it. */
const PAGE_DOWN = "\u001b[6~"

test("a question taller than the screen scrolls, from its first line to its options", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountDocked(tmp.path, 40, 20, [
    { key: "target", type: "string", description: sixtyLines, options: twoTargets, custom: true },
  ])
  try {
    await prompt.app.waitForFrame((frame) => frame.includes("line 1 of the question"))
    const first = prompt.app.captureCharFrame()
    expect(first).not.toContain("line 60 of the question")
    // The keys stay on screen while the question scrolls.
    expect(first).toContain("esc dismiss")
    // The dock's other rows keep their place; the question gives way.
    expect(first).toContain("tray")
    for (let page = 0; page < 20 && !prompt.app.captureCharFrame().includes("Type your own answer"); page++) {
      prompt.app.mockInput.pressKey(PAGE_DOWN)
      await prompt.app.renderOnce()
    }
    const end = prompt.app.captureCharFrame()
    expect(end).toContain("line 60 of the question")
    expect(end).toContain("Type your own answer")
    expect(end).toContain("esc dismiss")

    prompt.app.mockInput.pressArrow("down")
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { target: "production" } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("the mouse wheel scrolls a tall question", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountDocked(tmp.path, 40, 20, [
    { key: "target", type: "string", description: sixtyLines, options: twoTargets },
  ])
  try {
    await prompt.app.waitForFrame((frame) => frame.includes("line 1 of the question"))
    for (let step = 0; step < 100 && !prompt.app.captureCharFrame().includes("Production"); step++) {
      await prompt.app.mockMouse.scroll(10, 5, "down")
      await prompt.app.renderOnce()
    }
    expect(prompt.app.captureCharFrame()).toContain("line 60 of the question")
    expect(prompt.app.captureCharFrame()).toContain("Production")
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("the highlighted option stays in view in a long list", async () => {
  await using tmp = await tmpdir()
  const options = Array.from({ length: 30 }, (_, index) => ({
    value: `option-${index + 1}`,
    label: `Option ${index + 1}`,
  }))
  const prompt = await mountDocked(tmp.path, 40, 20, [
    { key: "target", type: "string", description: "Pick one", options, custom: true },
  ])
  try {
    await prompt.app.waitForFrame((frame) => frame.includes("Pick one"))
    expect(prompt.app.captureCharFrame()).not.toContain("Type your own answer")
    // Up from the first option wraps to the custom answer, the last row.
    prompt.app.mockInput.pressArrow("up")
    await prompt.app.waitForFrame((frame) => frame.includes("Type your own answer"))
    prompt.app.mockInput.pressArrow("down")
    await prompt.app.waitForFrame((frame) => frame.includes("1. Option 1"))
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a question that fits shows no scroll hint", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, [{ key: "target", type: "string", options: twoTargets, custom: true }])
  try {
    await prompt.app.waitForFrame((frame) => frame.includes("Production"))
    expect(prompt.app.captureCharFrame()).not.toContain("scroll")
  } finally {
    prompt.app.renderer.destroy()
  }
})

async function mountDialogForm(root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })

  const replies: unknown[] = []
  const cancellations: unknown[] = []
  const renames: unknown[] = []
  const events = createEventStream()
  const config = createTuiResolvedConfig({ animations: false })
  let dialog!: DialogContext

  const formID = `frm_${crypto.randomUUID()}`
  const transport = createFetch((url, request) => {
    if (url.pathname === "/api/session/ses_test" && request.method === "PATCH")
      return request.json().then((body) => {
        renames.push(body)
        return new Response(null, { status: 204 })
      })
    if (url.pathname === "/api/session/ses_test/form" && request.method === "GET") return json({ data: [] })
    if (url.pathname === `/api/session/ses_test/form/${formID}/reply`)
      return request.json().then((answer) => {
        replies.push(answer)
        events.emit({
          id: "evt_form_replied",
          created: 2,
          type: "form.replied",
          location: { directory },
          data: { id: formID, sessionID: "ses_test", answer: answer.answer },
        })
        return new Response(null, { status: 204 })
      })
    if (url.pathname === `/api/session/ses_test/form/${formID}` && request.method === "DELETE") {
      cancellations.push(true)
      events.emit({
        id: "evt_form_cancelled",
        created: 2,
        type: "form.cancelled",
        location: { directory },
        data: { id: formID, sessionID: "ses_test" },
      })
      return new Response(null, { status: 204 })
    }
  }, events)
  const { FormPrompt } = await import("../../../src/routes/session/form")

  function Scene() {
    const data = useData()
    dialog = useDialog()
    onMount(() => void data.session.form.sync("ses_test"))
    return (
      <box height="100%" justifyContent="flex-end">
        <Show when={data.session.form.list("ses_test")?.[0]} keyed fallback={<text>Composer ready</text>}>
          {(current) => <FormPrompt form={current} />}
        </Show>
      </box>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory} paths={{ home: root, state, worktree: directory }}>
        <ConfigProvider config={config}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <DataProvider directory={directory}>
                <ThemeProvider mode="dark" source={emptyThemeSource}>
                  <ToastProvider>
                    <DialogProvider>
                      <Scene />
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Composer ready"))

  const ask = (fields: Extract<OpenCodeEvent, { type: "form.created" }>["data"]["form"]["fields"]) =>
    events.emit({
      id: "evt_form_created",
      created: 1,
      type: "form.created",
      location: { directory },
      data: {
        form: {
          id: formID,
          sessionID: "ses_test",
          title: "Question",
          fields,
        },
      },
    })

  return { app, ask, cancellations, dialog: () => dialog, renames, replies }
}

test("arriving choice question keeps focus with an open rename dialog until it closes", async () => {
  await using tmp = await tmpdir()
  const scene = await mountDialogForm(tmp.path)
  try {
    DialogSessionRename.show(scene.dialog(), "ses_test", "Initial")
    await scene.app.waitForFrame(
      (frame) =>
        frame.includes("Rename session") && scene.app.renderer.currentFocusedRenderable instanceof TextareaRenderable,
    )

    scene.ask([
      {
        key: "approach",
        type: "string",
        description: "Which approach should I take?",
        options: [
          { value: "a", label: "Option A" },
          { value: "b", label: "Option B" },
        ],
        custom: true,
      },
    ])
    await scene.app.waitForFrame((frame) => frame.includes("Option A"))

    await scene.app.mockInput.typeText(" 2")
    scene.app.mockInput.pressArrow("down")
    scene.app.mockInput.pressEnter()
    await scene.app.waitForFrame((frame) => !frame.includes("Rename session"))

    expect(scene.renames).toEqual([{ title: "Initial 2" }])
    expect(scene.replies).toEqual([])
    expect(scene.cancellations).toEqual([])

    scene.app.mockInput.pressKey("2")
    await scene.app.waitFor(() => scene.replies.length === 1)
    expect(scene.replies).toEqual([{ answer: { approach: "b" } }])
  } finally {
    scene.app.renderer.destroy()
  }
})

test("arriving text question does not steal editor focus from an open rename dialog", async () => {
  await using tmp = await tmpdir()
  const scene = await mountDialogForm(tmp.path)
  try {
    DialogSessionRename.show(scene.dialog(), "ses_test", "Draft")
    await scene.app.waitForFrame(
      (frame) =>
        frame.includes("Rename session") && scene.app.renderer.currentFocusedRenderable instanceof TextareaRenderable,
    )

    scene.ask([{ key: "notes", type: "string", description: "Explain why" }])
    await scene.app.waitForFrame((frame) => frame.includes("Explain why"))

    await scene.app.mockInput.typeText(" title")
    scene.app.mockInput.pressEnter()
    await scene.app.waitForFrame(
      (frame) =>
        !frame.includes("Rename session") && scene.app.renderer.currentFocusedRenderable instanceof TextareaRenderable,
    )

    expect(scene.renames).toEqual([{ title: "Draft title" }])
    expect(scene.replies).toEqual([])

    await scene.app.mockInput.typeText("because")
    scene.app.mockInput.pressEnter()
    scene.app.mockInput.pressEnter()
    await scene.app.waitFor(() => scene.replies.length === 1)
    expect(scene.replies).toEqual([{ answer: { notes: "because" } }])
  } finally {
    scene.app.renderer.destroy()
  }
})

test("escape closes an open command palette instead of cancelling an arriving question", async () => {
  await using tmp = await tmpdir()
  const scene = await mountDialogForm(tmp.path)
  try {
    scene.dialog().replace(() => <CommandPaletteDialog />)
    await scene.app.waitForFrame(
      (frame) => frame.includes("Commands") && scene.app.renderer.currentFocusedRenderable instanceof InputRenderable,
    )

    scene.ask([
      {
        key: "approach",
        type: "string",
        options: [
          { value: "a", label: "Option A" },
          { value: "b", label: "Option B" },
        ],
      },
    ])
    await scene.app.waitForFrame((frame) => frame.includes("Option A"))

    scene.app.mockInput.pressEscape()
    await scene.app.waitForFrame((frame) => !frame.includes("Commands"))
    expect(scene.cancellations).toEqual([])
    expect(scene.app.captureCharFrame()).toContain("Option A")

    scene.app.mockInput.pressEnter()
    await scene.app.waitFor(() => scene.replies.length === 1)
    expect(scene.replies).toEqual([{ answer: { approach: "a" } }])
  } finally {
    scene.app.renderer.destroy()
  }
})
