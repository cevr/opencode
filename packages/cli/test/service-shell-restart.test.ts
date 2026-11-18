import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// A background shell command across `opencode service restart`, with real processes: a service from source, a
// scripted OpenAI-compatible model that starts the command, then the CLI's own restart. The command must keep
// running under the new server, stay listed, and end with the notice a finished background command gets, which
// wakes its session.

const entry = path.join(import.meta.dir, "../src/index.ts")
const serviceTest = process.platform === "win32" ? test.skip : test

type Message = { readonly role: string; readonly content?: unknown }
const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part?.text ?? "").join("")
      : ""

serviceTest(
  "a background shell command survives `opencode service restart` and notifies its session when it ends",
  async () => {
    await using home = await serviceHome()
    const pidFile = path.join(home.work, "bg.pid")
    const doneFile = path.join(home.work, "bg-done")
    // Every model request after a tool result or a notice: the last message the model was sent.
    const asked: string[] = []
    await using model = scriptedModel((last) => {
      asked.push(last)
      if (last.includes("run-shell"))
        return call("shell", {
          command: `echo $$ > '${pidFile}'; sleep 12; echo finished > '${doneFile}'; echo bg-finished`,
          background: true,
          description: "slow job",
        })
      return say(last.includes("<shell") ? "Done." : "Started.")
    })
    await home.configure(model.port)

    await cli(home, "service", "start")
    const before = await ready(home)
    const session = (
      (await api(before, home, "POST", "/api/session", { title: "shell", location: { directory: home.work } })) as {
        data: { id: string }
      }
    ).data
    await api(before, home, "POST", `/api/session/${session.id}/prompt`, { text: "run-shell please" })
    const pid = Number(await until(() => fs.readFile(pidFile, "utf8").catch(() => undefined)))
    await until(async () => (asked.length >= 2 ? true : undefined))
    expect(alive(pid)).toBe(true)

    await cli(home, "service", "restart")
    const after = await ready(home)
    expect(after.pid).not.toBe(before.pid)
    expect(alive(pid)).toBe(true)
    const listed = (await api(
      after,
      home,
      "GET",
      `/api/shell?exited=true&location[directory]=${encodeURIComponent(home.work)}`,
    )) as { data: ReadonlyArray<{ readonly pid?: number; readonly status: string }> }
    expect(listed.data.map((shell) => ({ pid: shell.pid, status: shell.status }))).toContainEqual({
      pid,
      status: "running",
    })

    // The command finishes under the new server; its end notice reaches the session and wakes it.
    const notice = await until(async () => asked.find((last) => last.includes("<shell")), 60_000)
    expect(notice).toContain('state="completed"')
    expect(notice).toContain("bg-finished")
    expect(await fs.readFile(doneFile, "utf8")).toBe("finished\n")
  },
  120_000,
)

type Home = Awaited<ReturnType<typeof serviceHome>>
type Registration = { readonly url: string; readonly password?: string; readonly pid: number }

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
    configure: async (modelPort: number) => {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        model: "sim/sim-model",
        providers: {
          sim: {
            name: "Sim",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${modelPort}/v1`, apiKey: "k" },
            models: {
              "sim-model": {
                name: "Sim",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
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
      // The background command, should a failed case leave it running.
      const shell = Number(await fs.readFile(path.join(work, "bg.pid"), "utf8").catch(() => "0"))
      if (shell > 0) signal(shell, "SIGKILL")
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

function scriptedModel(answer: (last: string) => Response) {
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
      return answer(text(messages.at(-1)?.content))
    },
  })
  return {
    port: server.port!,
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}

const chunk = (delta: object, finish: string | null) =>
  `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "sim", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const usage = `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "sim", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`
const stream = (lines: string[]) => new Response(lines.join(""), { headers: { "content-type": "text/event-stream" } })
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
  const child = Bun.spawn([process.execPath, home.entry, ...args], { env: home.env, stdout: "pipe", stderr: "pipe" })
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

/** The registered server once it answers. */
async function ready(home: Home) {
  return until(async () => {
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
  }, 60_000)
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
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("Server did not bind a port")
  return port
}
