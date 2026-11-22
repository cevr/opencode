import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// Background shell commands across a service restart, with real processes: a service from source, a scripted
// OpenAI-compatible model that starts the commands, then the CLI's own restart (what an install runs) or a signal.
// A command handed over keeps running under the new server, stays listed, and ends with the notice a finished
// background command gets, which wakes its session; one the restart stops still tells its session so.

const entry = path.join(import.meta.dir, "../src/index.ts")
const serviceTest = process.platform === "win32" ? test.skip : test

// The notice a background shell command's end sends its session (`ShellResult.notification`).
const NOTICE = '<background-result kind="shell"'

type Message = { readonly role: string; readonly content?: unknown }
/** One request the model got: its last message, and the text of every message in it, oldest first. */
type Asked = { readonly last: string; readonly history: ReadonlyArray<string> }
const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part?.text ?? "").join("")
      : ""

serviceTest(
  "a background shell command survives `opencode service restart` and notifies its idle session when it ends",
  async () => {
    await using home = await serviceHome()
    await using model = scriptedModel(jobs(home))
    await home.configure(model.port)
    const before = await boot(home)
    const session = await open(before, home)
    await prompt(before, home, session, "run-shell A")
    const pid = await started(home, model, "A")

    await cli(home, "service", "restart")
    const after = await ready(home)
    expect(after.pid).not.toBe(before.pid)
    expect(alive(pid)).toBe(true)
    expect(await shells(after, home)).toContainEqual({
      pid,
      status: "running",
    })

    // The command finishes under the new server; its end notice reaches the session and wakes it.
    await release(home, "A")
    const notice = await noticed(model, "A")
    expect(await fs.readFile(home.done("A"), "utf8")).toBe("finished\n")
    await completed(after, home, session, notice, "A", pid)
  },
  120_000,
)

serviceTest(
  "a background shell command that ends while `opencode service restart` has no server notifies its session once the next one starts",
  async () => {
    await using home = await serviceHome()
    await using model = scriptedModel(jobs(home))
    await home.configure(model.port)
    const before = await boot(home)
    const session = await open(before, home)
    await prompt(before, home, session, "run-shell A")
    const pid = await started(home, model, "A")

    const restart = cli(home, "service", "restart")
    // The old server is gone: end the command now, before the next server answers.
    await until(async () => (alive(before.pid) ? undefined : true), 60_000)
    await release(home, "A")
    await until(() => fs.readFile(home.done("A"), "utf8").catch(() => undefined))
    await until(async () => (alive(pid) ? undefined : true))
    expect(await answering(home, before.pid)).toBe(false)

    await restart
    const after = await ready(home)
    expect(after.pid).not.toBe(before.pid)
    await completed(after, home, session, await noticed(model, "A"), "A", pid)
  },
  120_000,
)

serviceTest(
  "background shell commands of two sessions each notify their own session after `opencode service restart`",
  async () => {
    await using home = await serviceHome()
    await using model = scriptedModel(jobs(home))
    await home.configure(model.port)
    const before = await boot(home)
    const first = await open(before, home)
    const second = await open(before, home)
    await prompt(before, home, first, "run-shell A")
    await prompt(before, home, second, "run-shell B")
    const pids = {
      A: await started(home, model, "A"),
      B: await started(home, model, "B"),
    }

    await cli(home, "service", "restart")
    const after = await ready(home)
    const listed = await shells(after, home)
    for (const pid of Object.values(pids)) expect(listed).toContainEqual({ pid, status: "running" })

    await release(home, "A")
    await release(home, "B")
    // Each notice lands in the session whose prompt started its command, and only there.
    for (const [tag, other, session] of [
      ["A", "B", first],
      ["B", "A", second],
    ] as const) {
      const notice = await noticed(model, tag)
      await completed(after, home, session, notice, tag, pids[tag])
      expect(notice.history.some((message) => message.includes(`run-shell ${tag}`))).toBe(true)
      expect(notice.history.some((message) => message.includes(`run-shell ${other}`))).toBe(false)
      expect(notice.history.some((message) => message.includes(`bg-finished-${other}`))).toBe(false)
    }
  },
  120_000,
)

serviceTest(
  "a background shell command that ends while its session is mid-turn after `opencode service restart` reaches that session",
  async () => {
    await using home = await serviceHome()
    const turn = { answered: false }
    const script = jobs(home)
    await using model = scriptedModel(async (asked) => {
      if (!asked.last.includes("slow-turn")) return script(asked)
      // The turn holds its model call while the command ends under it.
      await release(home, "A")
      await until(() => fs.readFile(home.done("A"), "utf8").catch(() => undefined))
      await Bun.sleep(1_500)
      turn.answered = true
      return say("Slow turn done.")
    })
    await home.configure(model.port)
    const before = await boot(home)
    const session = await open(before, home)
    await prompt(before, home, session, "run-shell A")
    const pid = await started(home, model, "A")

    await cli(home, "service", "restart")
    const after = await ready(home)
    await prompt(after, home, session, "slow-turn")
    const notice = await noticed(model, "A")
    // The notice came after the turn's answer, not as a second turn beside it.
    expect(turn.answered).toBe(true)
    await completed(after, home, session, notice, "A", pid)
    expect(notice.history.some((message) => message.includes("slow-turn"))).toBe(true)
  },
  120_000,
)

serviceTest(
  "a background shell command stopped by a signal-begun restart leaves its session a cancelled notice for its next turn",
  async () => {
    await using home = await serviceHome()
    await using model = scriptedModel(jobs(home))
    await home.configure(model.port)
    const before = await boot(home)
    const session = await open(before, home)
    await prompt(before, home, session, "run-shell A")
    const pid = await started(home, model, "A")

    // A service manager's stop (launchd, systemd) is SIGTERM with no handoff: the daemon stops with its commands.
    signal(before.pid, "SIGTERM")
    await until(async () => (alive(before.pid) ? undefined : true), 60_000)
    await until(async () => (alive(pid) ? undefined : true), 30_000)
    await cli(home, "service", "start")
    const after = await ready(home)
    expect(after.pid).not.toBe(before.pid)

    // The new server queues the cancelled notice in the session's inbox without waking it (`SessionRestart`'s
    // `resume: false`: a restart notice does not revive an idle owner); its next turn carries it.
    type Inbox = {
      data: ReadonlyArray<{
        type: string
        delivery: string
        payload: { text: string; metadata: object }
      }>
    }
    const queued = await until(async () => {
      const inbox = (await api(after, home, "GET", `/api/session/${session}/inbox`)) as Inbox
      return inbox.data.find((item) => item.type === "synthetic" && item.payload.text.includes(NOTICE))
    }, 60_000)
    expect(queued.delivery).toBe("steer")
    expect(queued.payload.text).toMatch(/^<background-result kind="shell" id="sh_\w+" state="cancelled" command="/)
    expect(queued.payload.metadata).toMatchObject({
      source: "shell",
      state: "cancelled",
    })
    expect(model.asked.some((asked) => asked.last.includes(NOTICE))).toBe(false)
    await prompt(after, home, session, "what happened")
    const next = await until(async () => model.asked.find((asked) => asked.last.includes("what happened")))
    const notice = next.history.find((message) => message.includes(NOTICE))
    expect(notice).toContain('state="cancelled"')
    expect(notice).toContain("Command cancelled because the server restarted")
  },
  120_000,
)

type Home = Awaited<ReturnType<typeof serviceHome>>
type Registration = {
  readonly url: string
  readonly password?: string
  readonly pid: number
}

/** The model's script for prompts `run-shell <tag>`: a background command that waits for its tag's release. */
function jobs(home: Home) {
  return (asked: Asked) => {
    const tag = /run-shell (\w+)/.exec(asked.last)?.[1]
    if (tag)
      return call("shell", {
        command: `echo $$ > '${home.pid(tag)}'; while [ ! -e '${home.gate(tag)}' ]; do sleep 0.05; done; echo finished > '${home.done(tag)}'; echo bg-finished-${tag}`,
        background: true,
        description: `job ${tag}`,
      })
    return say(asked.last.includes(NOTICE) ? "Done." : "Started.")
  }
}

/** The command for `tag` runs, and the model got the call's result. */
async function started(home: Home, model: { readonly asked: ReadonlyArray<Asked> }, tag: string) {
  const pid = Number(await until(() => fs.readFile(home.pid(tag), "utf8").catch(() => undefined)))
  // A later request of the same session: the call's result.
  await until(async () =>
    model.asked.some(
      (asked) =>
        asked.history.some((message) => message.includes(`run-shell ${tag}`)) && !asked.last.includes("run-shell"),
    )
      ? true
      : undefined,
  )
  expect(alive(pid)).toBe(true)
  return pid
}

const release = (home: Home, tag: string) => fs.writeFile(home.gate(tag), "")

/**
 * `notice` is the current notice of `tag`'s command ending with exit 0, whole: `<background-result kind="shell">`
 * with the shell ID, `state="completed"` and the command, then the final handle's line and the output. The session
 * holds it as a synthetic message whose metadata carries the final handle: exited, exit code 0, the command's PID.
 */
async function completed(
  registration: Registration,
  home: Home,
  session: string,
  notice: Asked,
  tag: string,
  pid: number,
) {
  const form = new RegExp(
    `^<background-result kind="shell" id="(sh_\\w+)" state="completed" command="[^\\n]*echo bg-finished-${tag}">\\n` +
      `\\1 · exited 0 · [^\\n]+\\nbg-finished-${tag}\\n\\n</background-result>$`,
  )
  expect(notice.last).toMatch(form)
  const id = form.exec(notice.last)?.[1]
  const listed = (await api(registration, home, "GET", `/api/session/${session}/message?type=synthetic&limit=20`)) as {
    data: ReadonlyArray<{ text: string; metadata: object }>
  }
  const message = listed.data.find((item) => item.text === notice.last)
  expect(message?.metadata).toMatchObject({
    source: "shell",
    shellID: id,
    jobID: id,
    state: "completed",
    exit: 0,
    handle: { id, state: "exited", exitCode: 0, pid },
  })
}

// The notice of `tag`'s command: its output line, not the command echoed in the tag's attributes.
const noticed = (model: { readonly asked: ReadonlyArray<Asked> }, tag: string) =>
  until(
    async () =>
      model.asked.find(
        (asked) => asked.last.includes(NOTICE) && new RegExp(`^bg-finished-${tag}$`, "m").test(asked.last),
      ),
    60_000,
  )

async function serviceHome() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-shell-restart-")))
  const work = path.join(root, "work")
  await fs.mkdir(work, { recursive: true })
  const port = await availablePort()
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await fs.writeFile(path.join(root, "config", "service-local.json"), JSON.stringify({ port }))
  // Processes spawned through this home's entry carry its path, so cleanup finds only this home's.
  const homeEntry = path.join(root, "opencode.ts")
  await fs.writeFile(homeEntry, `import ${JSON.stringify(entry)}\n`)
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(isolatedEnv(root)).filter((pair): pair is [string, string] => pair[1] !== undefined),
  )
  return {
    root,
    work,
    entry: homeEntry,
    env,
    registration: path.join(root, "state", "opencode", "service-local.json"),
    pid: (tag: string) => path.join(work, `bg-${tag}.pid`),
    gate: (tag: string) => path.join(work, `bg-${tag}.gate`),
    done: (tag: string) => path.join(work, `bg-${tag}.done`),
    configure: async (modelPort: number) => {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        model: "sim/sim-model",
        providers: {
          sim: {
            name: "Sim",
            package: "@opencode/ai/providers/openai-compatible",
            settings: {
              baseURL: `http://127.0.0.1:${modelPort}/v1`,
              apiKey: "k",
            },
            models: {
              "sim-model": {
                name: "Sim",
                capabilities: {
                  tools: true,
                  input: ["text"],
                  output: ["text"],
                },
                limit: { context: 128000, output: 16000 },
              },
            },
          },
        },
      })
    },
    async [Symbol.asyncDispose]() {
      await cli(this, "service", "stop").catch(() => undefined)
      const pids = await processes(homeEntry)
      pids.forEach((pid) => signal(pid, "SIGKILL"))
      // The background commands, should a failed case leave them running.
      for (const file of await fs.readdir(work).catch(() => [])) {
        if (!file.endsWith(".pid")) continue
        const shell = Number(await fs.readFile(path.join(work, file), "utf8").catch(() => "0"))
        if (shell > 0) signal(shell, "SIGKILL")
      }
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

function scriptedModel(answer: (asked: Asked) => Response | Promise<Response>) {
  const asked: Asked[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (!request.url.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as { messages?: Message[] }
      const messages = body.messages ?? []
      const system = messages
        .filter((message) => message.role === "system" || message.role === "developer")
        .map((message) => text(message.content))
        .join("\n")
      if (system.includes("You name conversations")) return say("Probe")
      const request_ = {
        last: text(messages.at(-1)?.content),
        history: messages
          .filter((message) => message.role !== "system" && message.role !== "developer")
          .map((message) => text(message.content)),
      }
      asked.push(request_)
      return answer(request_)
    },
  })
  return {
    port: server.port!,
    asked,
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}

const chunk = (delta: object, finish: string | null) =>
  `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "sim", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const usage = `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "sim", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`
const stream = (lines: string[]) =>
  new Response(lines.join(""), {
    headers: { "content-type": "text/event-stream" },
  })
const say = (value: string) =>
  stream([
    chunk({ role: "assistant", content: "" }, null),
    chunk({ content: value }, null),
    chunk({}, "stop"),
    usage,
    "data: [DONE]\n\n",
  ])
let calls = 0
const call = (name: string, args: object) =>
  stream([
    chunk({ role: "assistant", content: "" }, null),
    chunk(
      {
        tool_calls: [
          {
            index: 0,
            id: `call_${name}_${calls++}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      null,
    ),
    chunk({}, "tool_calls"),
    usage,
    "data: [DONE]\n\n",
  ])

async function cli(home: Pick<Home, "entry" | "env">, ...args: string[]) {
  const child = Bun.spawn([process.execPath, home.entry, ...args], {
    env: home.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`opencode ${args.join(" ")} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

const authorization = (registration: Registration) =>
  registration.password === undefined ? undefined : `Basic ${btoa(`opencode:${registration.password}`)}`

async function boot(home: Home) {
  await cli(home, "service", "start")
  return ready(home)
}

async function registered(home: Home) {
  const registration = (await Bun.file(home.registration)
    .json()
    .catch(() => undefined)) as Registration | undefined
  if (!registration) return undefined
  const auth = authorization(registration)
  const response = await fetch(new URL("/api/info", registration.url), {
    headers: auth ? { authorization: auth } : {},
    signal: AbortSignal.timeout(1_000),
  }).catch(() => undefined)
  return response?.ok ? registration : undefined
}

/** The registered server once it answers. */
const ready = (home: Home) => until(() => registered(home), 60_000)

/** Whether a server other than `previous` is registered and answering. */
const answering = async (home: Home, previous: number) => ((await registered(home))?.pid ?? previous) !== previous

async function open(registration: Registration, home: Home) {
  const session = (await api(registration, home, "POST", "/api/session", {
    title: "shell",
    location: { directory: home.work },
  })) as { data: { id: string } }
  return session.data.id
}

const prompt = (registration: Registration, home: Home, session: string, value: string) =>
  api(registration, home, "POST", `/api/session/${session}/prompt`, {
    text: value,
  })

async function shells(registration: Registration, home: Home) {
  const listed = (await api(
    registration,
    home,
    "GET",
    `/api/shell?exited=true&location[directory]=${encodeURIComponent(home.work)}`,
  )) as {
    data: ReadonlyArray<{ readonly pid?: number; readonly status: string }>
  }
  return listed.data.map((shell) => ({ pid: shell.pid, status: shell.status }))
}

async function api(registration: Registration, home: Home, method: string, route: string, body?: object) {
  const auth = authorization(registration)
  const response = await fetch(new URL(route, registration.url), {
    method,
    headers: {
      ...(auth ? { authorization: auth } : {}),
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(home.work),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const value = await response.text()
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${value}`)
  return value ? JSON.parse(value) : undefined
}

async function until<A>(read: () => Promise<A | undefined>, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (true) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition")
    await Bun.sleep(100)
  }
}

function alive(pid: number) {
  return signal(pid, 0)
}

async function processes(pattern: string) {
  const output = await Bun.$`pgrep -f ${pattern}`.nothrow().quiet().text()
  return output.split("\n").filter(Boolean).map(Number)
}

function signal(pid: number, value: NodeJS.Signals | 0) {
  try {
    process.kill(pid, value)
    return true
  } catch {
    return false
  }
}

async function availablePort() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("Server did not bind a port")
  return port
}
