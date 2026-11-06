// What one Escape does to a session while the composer is empty, decided
// without rendering. Within the grace period after this TUI sent the session's
// latest prompt, Escape cancels it: the run stops, the session reverts to before
// the prompt and the prompt comes back to the composer. After it, Escape
// interrupts and the prompt stays. A prompt still waiting in the session's
// inbox (queued, or a steer not yet delivered) comes back whatever the grace.

/** The default grace period, in milliseconds (`escape_cancel_grace` in the TUI config; 0 turns cancelling off). */
export const DEFAULT_GRACE_MS = 5000

/** A prompt this TUI sent: its message ID and when, by the local clock. */
export type Sent = { readonly messageID: string; readonly at: number }

export type EscapeIntent =
  /** Take the newest prompt still in the inbox back into the composer. */
  | { readonly type: "pull"; readonly inboxID: string; readonly delivery: "steer" | "queue" }
  /** Stop the run, revert to before the prompt and put it back in the composer; `left` ms of grace remain. */
  | { readonly type: "cancel"; readonly messageID: string; readonly left: number }
  /** Stop the run; the prompt and its partial answer stay. */
  | { readonly type: "interrupt" }
  /** Escape means nothing to the session now. */
  | { readonly type: "none" }

export function escapeIntent(input: {
  /** The session's run is going. */
  readonly busy: boolean
  /** The composer holds text or attachments. */
  readonly draft: boolean
  /** The session's user prompts still in its inbox, oldest first. */
  readonly pending: readonly { readonly id: string; readonly delivery: "steer" | "queue" }[]
  /** The newest user message the transcript shows. */
  readonly latestUserID: string | undefined
  /** The prompt this TUI last sent to the session. */
  readonly sent: Sent | undefined
  readonly now: number
  readonly grace: number
}): EscapeIntent {
  if (input.draft) return { type: "none" }
  const queued = input.pending.at(-1)
  if (queued) return { type: "pull", inboxID: queued.id, delivery: queued.delivery }
  if (!input.busy) return { type: "none" }
  const sent = input.sent
  if (sent && sent.messageID === input.latestUserID) {
    const left = sent.at + input.grace - input.now
    if (left > 0) return { type: "cancel", messageID: sent.messageID, left }
  }
  return { type: "interrupt" }
}

/** The grace period the config asks for, in milliseconds: the default when unset, never negative. */
export function graceMs(configured: number | undefined) {
  if (configured === undefined || !Number.isFinite(configured)) return DEFAULT_GRACE_MS
  return Math.max(0, configured)
}

/** Whole seconds of grace left, as the hint counts them down: 4.2 s reads 5s, 0.1 s reads 1s. */
export function secondsLeft(left: number) {
  return Math.max(1, Math.ceil(left / 1000))
}

/**
 * The hint's words after `esc`: `cancel and edit · 4s`, `interrupt`, `edit queued` (a queued prompt) or
 * `cancel and edit` (a steer the model has not read yet); none when Escape does nothing.
 */
export function escapeLabel(intent: EscapeIntent) {
  if (intent.type === "cancel") return `cancel and edit · ${secondsLeft(intent.left)}s`
  if (intent.type === "interrupt") return "interrupt"
  if (intent.type === "pull") return intent.delivery === "queue" ? "edit queued" : "cancel and edit"
  return undefined
}

// The prompts this TUI sent, one per session, across session-view remounts (the view is keyed by session).
const sent = new Map<string, Sent>()

/** Records that this TUI sent `messageID` to the session at `at`. */
export function noteSent(sessionID: string, messageID: string, at: number) {
  sent.set(sessionID, { messageID, at })
}

/** The prompt this TUI last sent to the session. */
export function lastSent(sessionID: string) {
  return sent.get(sessionID)
}
