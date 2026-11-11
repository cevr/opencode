export type ServiceReadyFetchOptions = {
  /** Called once, at the first request this fetch holds back because the service is down or starting. */
  readonly onWait?: () => void
}

/** Bun's error for a connection nothing accepted (the socket gap of a restart); a browser's fetch does not say. */
function refused(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ECONNREFUSED"
}

/** The process readiness handler refuses requests before dispatching them.
 * Only that explicit refusal is safe to replay, including a prompt POST,
 * and so is a connection refused, which no server received.
 * Reads can also wait through the restart's socket gap. Never replay a
 * mutation after an ambiguous transport failure, or an application's own 503.
 */
export function serviceReadyFetch(
  fetch: typeof globalThis.fetch,
  options: ServiceReadyFetchOptions = {},
): typeof globalThis.fetch {
  let waited = false
  const waiting = () => {
    if (waited) return
    waited = true
    options.onWait?.()
  }
  const request = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const deadline = Date.now() + 60_000
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const read = method === "GET" || method === "HEAD"
    const wait = (delay: number) => new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", done)
        if (signal?.aborted) reject(signal.reason)
        else resolve()
      }
      const timer = setTimeout(done, Math.min(delay, Math.max(0, deadline - Date.now())))
      signal?.addEventListener("abort", done, { once: true })
      if (signal?.aborted) done()
    })
    for (;;) {
      signal?.throwIfAborted()
      const response = await fetch(input, init).catch((error: unknown) => {
        // A refused connection never reached a server, so even a mutation is safe to send again.
        if (!(read || refused(error)) || signal?.aborted || Date.now() >= deadline) throw error
        return undefined
      })
      if (!response) {
        waiting()
        await wait(1_000)
        continue
      }
      if (response.status !== 503 || Date.now() >= deadline) return response
      const body: unknown = await response.clone().json().catch(() => undefined)
      if (
        typeof body !== "object" ||
        body === null ||
        !("code" in body) ||
        (body.code !== "service_starting" && body.code !== "service_stopping")
      )
        return response
      await response.body?.cancel()
      waiting()
      const seconds = Number(response.headers.get("retry-after") ?? "1")
      const delay = Number.isFinite(seconds) ? Math.max(100, Math.min(5_000, seconds * 1000)) : 1_000
      await wait(delay)
    }
  }
  // Bun's fetch has preconnect; the DOM's (the desktop app) does not.
  return Object.assign(request, "preconnect" in fetch ? { preconnect: fetch.preconnect } : {}) as typeof globalThis.fetch
}
