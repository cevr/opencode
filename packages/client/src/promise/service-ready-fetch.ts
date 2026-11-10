/** The process readiness handler refuses requests before dispatching them.
 * Only that explicit refusal is safe to replay, including a prompt POST:
 * never retry an ambiguous transport failure or an application's own 503.
 */
export function serviceReadyFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  const request = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const deadline = Date.now() + 60_000
    for (;;) {
      signal?.throwIfAborted()
      const response = await fetch(input, init)
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
      const seconds = Number(response.headers.get("retry-after") ?? "1")
      const delay = Number.isFinite(seconds) ? Math.max(100, Math.min(5_000, seconds * 1000)) : 1_000
      await new Promise<void>((resolve, reject) => {
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
    }
  }
  return Object.assign(request, { preconnect: fetch.preconnect })
}
