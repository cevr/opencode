import type { ExperimentalSessionApi, SessionApi } from "@opencode/client/effect/api"
import type { GenerationOptionsFields, Message, SystemPart } from "@opencode/ai/effect"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { SessionError } from "@opencode/schema/session-error"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { TokenUsage } from "@opencode/schema/token-usage"
import type { Effect, JsonSchema, Types } from "effect"
import type { ModelHooks } from "./registration.js"

export interface SessionPrompt {
  readonly sessionID: Session.ID
  readonly messageID: SessionMessage.ID
  prompt: Types.DeepMutable<PromptInput.Prompt>
  metadata?: Record<string, unknown>
  delivery: SessionInbox.Delivery
}

/** Request overrides. Typed keys are generation settings; any other key is a provider option. */
export type SessionRequestOptions = Types.DeepMutable<GenerationOptionsFields> & Record<string, unknown>

/** A request message. `metadata` is the stored Session message's metadata, for reading only; it is not sent to the model. */
export type SessionRequestMessage = Message & { readonly metadata?: Record<string, unknown> }

export interface SessionRequest {
  readonly sessionID: Session.ID
  readonly model: Model.Ref
  /**
   * The instructions part keeps each source's text in `metadata.experimental.instructions` as `{ key, text }`. It is
   * not updated when a hook edits `text`. Experimental.
   */
  system: Array<SystemPart>
  messages: Array<SessionRequestMessage>
  options: SessionRequestOptions
}

export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
}

export interface SessionCompactionResult {
  summary: string
  /** `native.messages`, when set, must be a provider replacement window; it replays instead of `summary`. */
  native?: SessionMessage.Native
  metadata?: Record<string, unknown>
  tokens?: TokenUsage.Info
}

export interface SessionCompaction extends SessionContext {
  /** Set to use this compaction and skip the model request. */
  result?: SessionCompactionResult
}

export interface SessionGenerate extends SessionContext {}

export interface SessionTitle extends SessionRequest {
  /** Set to use this title and skip the model request. */
  result?: string
}

/**
 * Why a Session request is being made. Auxiliary requests share the Session's
 * hook identity but need to be told apart from the agent loop.
 */
export type SessionRequestKind = "primary" | "compaction" | "title" | "generate"

/**
 * Where the model a resolution starts from came from. `explicit`: the Session's own selection, made by a user or
 * caller (a selection recorded without provenance counts as explicit). `default`: the Session's selection, recorded by a
 * client from its implicit default rather than a pick. `agent`: no Session selection; the agent's configured model.
 * `fallback`: neither; the host's default model.
 */
export type SessionModelOrigin = "explicit" | "default" | "agent" | "fallback"

/**
 * One durable Step of the Session's agent loop, as routing sees it. `id` stays the same while the Step is held,
 * refused or retried, and changes for the next Step (after a completed tool call, say) and after a restart, which
 * routes the unfinished Step again from attempt 1. Only the Session runner's primary requests carry a Step.
 */
export interface SessionRouteStep {
  readonly id: string
  /** 1 for the Step's first resolution, then one more each time the Step re-enters routing. */
  readonly attempt: number
  /**
   * The model the Step's previous attempt was routed to. `sent` is true when that attempt may have reached the
   * provider (an ordinary failure being retried, a provider overflow, a cut-off stream). The host then keeps this
   * attempt on that provider: a hook may defer it, but a change of provider is ignored.
   */
  readonly previous?: { readonly model: Model.Ref; readonly sent: boolean }
}

/**
 * Holds a Step instead of sending it. Nothing is sent and nothing fails: the Step waits, interruptibly, in the same
 * execution and re-enters routing at `until` (epoch milliseconds). While it waits the Session shows `reason` as the
 * Step's retry state. The host waits at least one second, so a past `until` cannot spin.
 */
export interface SessionRouteDefer {
  readonly reason: string
  readonly until: number
}

/**
 * Refuses one concrete send. The host does not send it, settles nothing as failed, and re-enters routing for the
 * Step: at `until` when given (held as {@link SessionRouteDefer}), else at once. Honored only before any request of
 * the attempt reached the network; after one did, a refusal fails the attempt like any transport failure.
 */
export interface SessionRouteRefuse {
  readonly reason: string
  readonly until?: number
}

/**
 * Runs whenever a Session resolves the model for a request, before anything is built for it. `model` starts as the
 * Session's or agent's selection, `origin` says which, and `available` whether that model is offered in the Session's
 * location (an unavailable one fails the request unless a hook changes it). Change `model` to serve this request with
 * another model: from the same provider, including models hidden from the picker, or an offered model from another
 * provider, which then serves with that provider's own credentials, hooks, tools and history rendering. The Session
 * keeps its selection, and the request and its records use the new model. Router models such as GitHub Copilot's
 * Auto use it.
 *
 * The runner's primary requests carry `step` and, before anything is built, may set `defer` to hold the Step (see
 * {@link SessionRouteDefer}); `defer` is ignored on other requests. Experimental.
 */
export interface SessionModelResolve {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly kind: SessionRequestKind
  readonly origin: SessionModelOrigin
  readonly available: boolean
  readonly step?: SessionRouteStep
  model: Model.Ref
  defer?: SessionRouteDefer
}

export interface SessionModelRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  baseURL?: string
  headers: Record<string, string>
}

/**
 * Each concrete HTTP request, just before it is sent. A primary request of the runner carries its `step` and may set
 * `refuse` to keep this request from being sent (see {@link SessionRouteRefuse}); elsewhere `refuse` fails the request.
 * A hook that throws fails the request as before.
 */
export interface SessionHttpRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  readonly step?: SessionRouteStep
  request: Request
  refuse?: SessionRouteRefuse
}

export interface SessionHttpResponse {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  readonly request: Request
  response: Response
}

/**
 * Connection a WebSocket-backed request opens or reuses. Runs once per model call before the
 * Session's socket is selected; changing `url` or `headers` reopens the socket. Experimental.
 */
export interface SessionWebSocketHandshake {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  url: string
  headers: Record<string, string>
}

/**
 * Outbound frame about to be written to the Session's socket, after the provider driver has built
 * it. Replacing `frame` sends the replacement verbatim; the driver still tracks state from the
 * provider's replies, so a rewrite that changes protocol meaning is on the plugin. Setting `refuse` keeps the frame
 * from being written and closes the socket (see {@link SessionRouteRefuse}); only a primary request with a `step`
 * honors it. Experimental.
 */
export interface SessionWebSocketSend {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  readonly step?: SessionRouteStep
  frame: string
  refuse?: SessionRouteRefuse
}

/**
 * Inbound frame read from the Session's socket, before the provider driver observes it. Replacing
 * `frame` hands the replacement to the driver verbatim. Experimental.
 */
export interface SessionWebSocketReceive {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  frame: string
}

export type SessionRetryDecision = { retry: false } | { retry: true; delay: number }

export interface SessionRetry {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly error: SessionError.Error
  readonly attempt: number
  decision: SessionRetryDecision
}

/**
 * Background work still running for the idle Session or one of its descendants. `sessionID` is
 * the Session that owns the job: the idle Session itself, or a descendant such as a subagent child.
 */
export type SessionIdleBackground =
  | { readonly kind: "codemode"; readonly sessionID: Session.ID; readonly jobID: string }
  | {
      readonly kind: "shell"
      readonly sessionID: Session.ID
      readonly shellID: string
      readonly command: string
    }
  | {
      readonly kind: "subagent"
      readonly sessionID: Session.ID
      readonly childSessionID: Session.ID
      readonly agent: string
      readonly description: string
    }
  | {
      readonly kind: "image"
      readonly sessionID: Session.ID
      readonly path: string
      readonly model: string
    }
  | {
      readonly kind: "video"
      readonly sessionID: Session.ID
      readonly path: string
    }

/**
 * Runs when a Session finishes model work and has no pending input, just before it goes idle.
 * It does not run after interruption, failure, or control-only work such as a manual compaction.
 * Input admitted by the hook, such as a synthetic message, runs in the same execution instead
 * of the Session going idle.
 *
 * `background` lists work that is still running. When the Session's own shell or subagent finishes,
 * its notice wakes the Session and the hook runs again, so a plugin that waits for that work can
 * simply return. Work a descendant owns, such as a shell a subagent left running, wakes that
 * descendant instead, so it is listed for information only. Notices admitted with `resume: false`,
 * such as those recovered after a restart, wait for the next wake. Experimental.
 */
export interface SessionIdle {
  readonly sessionID: Session.ID
  readonly background: ReadonlyArray<SessionIdleBackground>
}

/**
 * Runs at an idle boundary that is about to deliver the oldest queued prompt while more queued user prompts wait
 * behind it, before any of them is delivered. `prompts` lists those waiting user prompts, oldest first, up to the
 * first queued item that is not a user prompt. Set `take` to n (2 to `prompts.length`) to deliver the oldest n as
 * one user message: their texts joined by `separator`, their attachments in order, the first one's metadata. The
 * default `take` of 1 delivers the oldest alone, as without the hook. Experimental.
 */
export interface SessionQueueDeliver {
  readonly sessionID: Session.ID
  readonly prompts: ReadonlyArray<{ readonly id: SessionMessage.ID; readonly text: string }>
  take: number
  separator: string
}

/**
 * Runs after a compaction of the Session completes (automatic, overflow or requested, a swapped-in background summary
 * included), once it is recorded and before the Session continues: the next request is built only after every hook
 * has returned, from the Session as the hooks left it. A hook that switches the Session's model there makes the next
 * request the new model's first, which reads only the summary. `model` is the Session's model the compaction ran
 * under, and `reason` is the recorded compaction's. It does not run for a compaction that fails or is interrupted. A
 * hook that fails is logged and changes nothing about the compaction. Experimental.
 */
export interface SessionCompactionEnded {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly reason: SessionMessage.CompactionReason
  readonly model: Model.Ref
}

/**
 * Runs once as the Session starts an execution on input (a prompt, a synthetic message, a requested compaction or
 * move), after the plugins are active and before that input is delivered or any context is loaded or request built.
 * The mirror of `experimental.idle`. It does not run for a steer delivered into a running turn, nor for a
 * continuation after a move, reload or restart recovery, which carry no new input. The execution waits for every
 * hook, then reads the Session as the hooks left it, so a model switched there serves its first request. A hook that
 * fails is logged and the execution goes on. Experimental.
 */
export interface SessionWake {
  readonly sessionID: Session.ID
}

export interface SessionHooks {
  readonly fork: { readonly sessionID: Session.ID }
  readonly prompt: SessionPrompt
  readonly context: SessionContext
  readonly compaction: SessionCompaction
  readonly "experimental.compaction.ended": SessionCompactionEnded
  readonly generate: SessionGenerate
  readonly title: SessionTitle
  readonly "experimental.model.resolve": SessionModelResolve
  readonly "model.request": SessionModelRequest
  readonly "http.request": SessionHttpRequest
  readonly "http.response": SessionHttpResponse
  readonly "experimental.ws.handshake": SessionWebSocketHandshake
  readonly "experimental.ws.send": SessionWebSocketSend
  readonly "experimental.ws.receive": SessionWebSocketReceive
  readonly retry: SessionRetry
  readonly "experimental.wake": SessionWake
  readonly "experimental.idle": SessionIdle
  readonly "experimental.queue.deliver": SessionQueueDeliver
}

export type SessionDomain = Pick<
  SessionApi<unknown>,
  | "list"
  | "create"
  | "get"
  | "remove"
  | "switchAgent"
  | "switchModel"
  | "prompt"
  | "generate"
  | "command"
  | "compact"
  | "synthetic"
  | "interrupt"
  | "update"
  | "move"
  | "context"
> &
  Pick<ExperimentalSessionApi<unknown>, "wait" | "instructions"> & {
    readonly hook: ModelHooks<SessionHooks>
    /**
     * Stops the Session until it is given work again: interrupts its turn, cancels the background work it owns (its
     * shells, its own subagents' jobs) and its queued input, and resolves once it has settled. A running subagent
     * reports cancelled to its parent once; while stopped, a notice does not wake it and nothing more reaches its
     * parent, until its parent's subagent tool gives it a new task. Experimental.
     */
    readonly stop: (input: {
      readonly sessionID: Session.ID
    }) => Effect.Effect<{ readonly interrupted: boolean }, unknown>
  }
