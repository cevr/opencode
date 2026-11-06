import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { Data } from "./data"

export function createSessionRetention(input: {
  session: Pick<Data["session"], "list" | "root" | "evict" | "status"> & {
    message?: Partial<Pick<Data["session"]["message"], "list" | "evict">>
  }
  current: Accessor<string | undefined>
  keep: Accessor<readonly string[]>
  limit: number
  /**
   * Inside a retained family, drop the transcript of a descendant that has been idle this long. The
   * viewed session, its ancestors, kept sessions and any session `working` names keep theirs. A dropped
   * transcript reloads when the session is viewed; a new run's events rebuild it from that run on.
   */
  idle?: {
    after: number
    working?: (sessionID: string) => boolean
    now?: () => number
  }
}) {
  let previous: string | undefined
  let recent: string[] = []
  let evicted = new Map<string, string>()
  let settled = new Map<string, string>()
  const [tick, setTick] = createSignal(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))

  createEffect(() => {
    const viewed = input.current()
    const current = viewed === undefined ? undefined : input.session.root(viewed)
    const keep = new Set(input.keep().map((id) => input.session.root(id)))
    // Resolve again when metadata arrives, but only navigation advances recency.
    recent = [
      ...new Set([
        ...(viewed !== previous && current !== undefined ? [current] : []),
        ...recent.map((id) => input.session.root(id)),
      ]),
    ]
    previous = viewed
    const retained = new Set([...keep, ...recent.filter((id) => !keep.has(id)).slice(0, input.limit)])
    if (current !== undefined) retained.add(current)
    recent = recent.filter((id) => retained.has(id))

    const count = (id: string) => untrack(() => input.session.message?.list?.(id).length ?? 0)
    const sessions = input.session.list()
    const excluded = new Map(
      sessions.flatMap((session) => {
        const root = input.session.root(session.id)
        return retained.has(root) ? [] : [[session.id, root] as const]
      }),
    )
    // New descendants and non-retained sessions repopulated by background turns need eviction even when their root was already evicted.
    const roots = new Set(
      [...excluded].filter(([id, root]) => evicted.get(id) !== `${root}:${count(id)}`).map(([, root]) => root),
    )
    untrack(() => roots.forEach((root) => input.session.evict(root)))
    evicted = new Map([...excluded].map(([id, root]) => [id, `${root}:${count(id)}`]))

    const idle = input.idle
    const evict = input.session.message?.evict
    if (!idle || !evict) return
    tick()
    const now = (idle.now ?? Date.now)()
    const parent = new Map(sessions.map((session) => [session.id, session.parentID]))
    // The viewed session and its ancestors stay, so the transcript on screen and the way back to it keep theirs.
    const shown = new Set<string>(input.keep())
    let walk = viewed
    while (walk !== undefined && !shown.has(walk)) {
      shown.add(walk)
      walk = parent.get(walk)
    }
    let next = Infinity
    const past: string[] = []
    sessions.forEach((session) => {
      if (!session.parentID || excluded.has(session.id) || shown.has(session.id)) return
      const since = session.time.idle
      if (since === undefined || input.session.status(session.id) === "running") return
      if (idle.working?.(session.id)) return
      const at = since + idle.after
      if (at > now) next = Math.min(next, at)
      else past.push(session.id)
    })
    // A transcript is dropped once per size, so a session whose kept rows survive eviction is not evicted again.
    const due = past.filter((id) => count(id) > 0 && settled.get(id) !== `${count(id)}`)
    untrack(() => due.forEach((id) => evict(id)))
    settled = new Map(past.map((id) => [id, `${count(id)}`]))
    clearTimeout(timer)
    timer = next === Infinity ? undefined : setTimeout(() => setTick((value) => value + 1), next - now)
  })
}
