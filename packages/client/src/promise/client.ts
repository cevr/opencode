export * as OpenCode from "./client.js"

import { SharedEvents } from "../shared-events.js"
import { OpenCode } from "./generated/index.js"
import type { ClientOptions } from "./generated/client.js"
import { makeRpc } from "./rpc.js"
import { serviceReadyFetch } from "./service-ready-fetch.js"

export type { ClientOptions, RequestOptions } from "./generated/client.js"

export function make(options: ClientOptions) {
  const raw = OpenCode.make({ ...options, fetch: serviceReadyFetch(options.fetch ?? globalThis.fetch) })
  const events = SharedEvents.make((signal, onActivity) => raw.event.subscribe(undefined, { signal, onActivity }))
  return {
    ...raw,
    rpc: Object.assign(makeRpc(raw, events), raw.rpc),
    event: events,
  }
}
