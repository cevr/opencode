// Fork feature (synthetic-archived): two OpenCode processes over one database file (the CLI's standalone server and
// the service open the same opencode.db). Process A archives a session; process B runs a plugin's /pick in it, which
// selects plan and m2 and prompts. What holds across processes is what SQLite serialises: the admission's check and
// the rows it writes are one write transaction, so A's archive lands wholly before B's admitting transaction (B is
// refused, the session's rows byte-identical to A's archive alone) or wholly after it (B admitted, then archived).
// Each run stops one process at one step (fixture/admission-process.ts) and lets the other act there.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode/core/database/database"
import { Session } from "@opencode/core/session"
import { dump } from "./fixture/admission-model"
import { commandLayer, create, writeProject } from "./fixture/command-selection"
import { tmpdir } from "./fixture/tmpdir"

const worker = path.join(import.meta.dir, "fixture", "admission-process.ts")
const children = new Set<number>()
afterAll(() => {
  // Each worker runs in a process group of its own; end any a failed test left.
  for (const pid of children) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  }
})

type Outcome = { readonly actor: string; readonly step: string; readonly outcome: string }

/** A database file with one session in a project that has the /pick command; the test's own reads go through `read`. */
async function setup() {
  const dir = (await tmpdir()).path
  const project = path.join(dir, "project")
  const control = path.join(dir, "control")
  mkdirSync(project, { recursive: true })
  mkdirSync(control, { recursive: true })
  await writeProject(project)
  const file = path.join(dir, "opencode.db")
  const runtime = ManagedRuntime.make(commandLayer([], file))
  const session = await runtime.runPromise(create(project))
  const read = <A>(effect: Effect.Effect<A, unknown, Session.Service | Database.Service>) =>
    runtime.runPromise(effect as Effect.Effect<A, never, Session.Service | Database.Service>)
  const rows = () => read(Database.Service.use(({ db }) => dump(db, session.id)))
  const info = () => read(Session.Service.use((sessions) => sessions.get(session.id)))
  const messages = () =>
    read(
      Session.Service.use((sessions) => sessions.messages({ sessionID: session.id, order: "asc" })).pipe(
        Effect.map((list) => list.map((message) => message.type)),
      ),
    )
  const inbox = () =>
    read(
      Session.Service.use((sessions) => sessions.inbox(session.id)).pipe(
        Effect.map((list) => list.map((item) => item.type)),
      ),
    )
  return { file, control, session, rows, info, messages, inbox, dispose: () => runtime.dispose() }
}

/** Starts one process; `done` answers its outcome. */
function start(
  file: string,
  control: string,
  sessionID: string,
  actor: "command" | "archive",
  step = "none",
  name = "pick",
) {
  const child = Bun.spawn(["bun", worker, file, control, sessionID, actor, step, name], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir,
    detached: true,
  })
  children.add(child.pid)
  let finished = false
  const done = (async (): Promise<Outcome> => {
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    await child.exited
    finished = true
    children.delete(child.pid)
    const last = out.trim().split("\n").at(-1) ?? ""
    try {
      return JSON.parse(last) as Outcome
    } catch {
      return { actor, step, outcome: `no outcome: ${last} ${err.slice(-2000)}` }
    }
  })()
  return { done, finished: () => finished }
}

/** Waits until a process stopped at `step`. */
async function reached(control: string, step: string) {
  for (let waited = 0; !existsSync(path.join(control, step)); waited += 10) {
    if (waited > 60_000) throw new Error(`never reached ${step}`)
    await Bun.sleep(10)
  }
}

const go = (control: string, step: string) => writeFileSync(path.join(control, `go-${step}`), "")

describe("two processes over one database: an archive and a plugin's command", () => {
  test("archive first, then the command: refused at entry, rows byte-identical", async () => {
    const run = await setup()
    expect((await start(run.file, run.control, run.session.id, "archive").done).outcome).toBe("archived")
    const archived = await run.rows()
    expect((await start(run.file, run.control, run.session.id, "command").done).outcome).toBe("refused")
    expect(await run.rows()).toBe(archived)
    await run.dispose()
  }, 120_000)

  // `/pick` also selects plan, whose reminder (a plugin's synthetic) is itself refused inside the transaction; `/m2`
  // selects a model only, so the admission's own check inside the transaction is all that refuses it.
  for (const name of ["pick", "m2"] as const)
    for (const step of ["selected", "prepare"] as const)
      test(`/${name}: archive while the command is stopped at ${step}: refused, rows byte-identical, nothing selected`, async () => {
        const run = await setup()
        const command = start(run.file, run.control, run.session.id, "command", step, name)
        await reached(run.control, step)
        expect((await start(run.file, run.control, run.session.id, "archive").done).outcome).toBe("archived")
        const archived = await run.rows()
        go(run.control, step)
        expect((await command.done).outcome).toBe("refused")
        expect(await run.rows()).toBe(archived)
        const info = await run.info()
        expect([String(info.agent), String(info.model?.id)]).toEqual(["build", "m"])
        await run.dispose()
      }, 120_000)

  for (const name of ["pick", "m2"] as const)
    test(`/${name} past its early check, its transaction waiting on the archive's: refused once that commits`, async () => {
      const run = await setup()
      // The command reads the session (not archived) and stops in its prompt's hook, past its early check.
      const command = start(run.file, run.control, run.session.id, "command", "prepare", name)
      await reached(run.control, "prepare")
      // The archive stops inside its transaction, holding SQLite's write lock (a process that must write cannot even
      // start while it does: measured, the command's process never reached its hook when started after this).
      const archive = start(run.file, run.control, run.session.id, "archive", "inside")
      await reached(run.control, "inside")
      go(run.control, "prepare")
      // Its admitting transaction cannot begin while the archive's holds SQLite's write lock.
      await Bun.sleep(1000)
      expect(command.finished()).toBe(false)
      go(run.control, "inside")
      expect((await archive.done).outcome).toBe("archived")
      const archived = await run.rows()
      expect((await command.done).outcome).toBe("refused")
      expect(await run.rows()).toBe(archived)
      const info = await run.info()
      expect([String(info.agent), String(info.model?.id)]).toEqual(["build", "m"])
      await run.dispose()
    }, 120_000)

  test("archive while the command is inside its admitting transaction: the archive waits, then lands after it", async () => {
    const run = await setup()
    const command = start(run.file, run.control, run.session.id, "command", "inside")
    await reached(run.control, "inside")
    const archive = start(run.file, run.control, run.session.id, "archive")
    // The archive's process is about to write; it cannot pass SQLite's write lock while the command holds it.
    await reached(run.control, "archive-started")
    await Bun.sleep(1000)
    expect(archive.finished()).toBe(false)
    go(run.control, "inside")
    expect((await command.done).outcome).toBe("admitted")
    expect((await archive.done).outcome).toBe("archived")
    const info = await run.info()
    expect(String(info.agent)).toBe("plan")
    expect(info.time.archived).toBeDefined()
    // Admitted in upstream's order: the selection, then the prompt (delivered, or waiting in the inbox
    // when the archive landed before the turn took them).
    const written = [...(await run.messages()), ...(await run.inbox())]
    expect(written.slice(0, 3)).toEqual(["agent-switched", "model-switched", "user"])
    await run.dispose()
  }, 120_000)

  test("the command first, then the archive: admitted, then archived", async () => {
    const run = await setup()
    expect((await start(run.file, run.control, run.session.id, "command").done).outcome).toBe("admitted")
    expect((await start(run.file, run.control, run.session.id, "archive").done).outcome).toBe("archived")
    expect(String((await run.info()).agent)).toBe("plan")
    await run.dispose()
  }, 120_000)

  test("the command started while the archive is inside its transaction: refused, rows byte-identical", async () => {
    const run = await setup()
    const archive = start(run.file, run.control, run.session.id, "archive", "inside")
    await reached(run.control, "inside")
    const command = start(run.file, run.control, run.session.id, "command")
    // The command reads the session (not yet archived for it) and reaches its admitting transaction, which waits.
    await reached(run.control, "command-started")
    await Bun.sleep(1500)
    expect(command.finished()).toBe(false)
    go(run.control, "inside")
    expect((await archive.done).outcome).toBe("archived")
    const archived = await run.rows()
    expect((await command.done).outcome).toBe("refused")
    expect(await run.rows()).toBe(archived)
    expect(String((await run.info()).agent)).toBe("build")
    await run.dispose()
  }, 120_000)
})
