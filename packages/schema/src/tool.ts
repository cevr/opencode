export * as Tool from "./tool.js"

import { Effect, JsonSchema, Schema } from "effect"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Agent } from "./agent.js"
import type { Session } from "./session.js"
import type { SessionMessage } from "./session-message.js"

export type Metadata = Readonly<Record<string, any>>

export const CallID = Schema.String.pipe(Schema.brand("Tool.CallID"))
export type CallID = typeof CallID.Type

export interface Context {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly messageID: SessionMessage.ID
  readonly id: CallID
  readonly progress: (update: Metadata) => Effect.Effect<void>
  /** The agent's other tools, present while this tool is its runtime (`options.runtime`). */
  readonly runtime?: Runtime
}

/** What a runtime tool reaches: every other tool the agent may use, called as the registry calls it. */
export interface Runtime {
  readonly tools: ReadonlyArray<RuntimeTool>
  /**
   * Runs one tool by name with this call's context, through the `execute.before` and
   * `execute.after` hooks, as a direct or Code Mode call runs. The tool asks for its
   * own permissions; a wholly denied tool is not listed and cannot be called.
   */
  readonly call: (name: string, input: unknown) => Effect.Effect<Result, Error>
}

export interface RuntimeTool {
  readonly name: string
  readonly description: string
  readonly input: JsonSchema.JsonSchema
}

export interface Namespace {
  readonly name: string
  readonly description: string
}

interface BaseOptions {
  readonly namespace?: string
  readonly permission?: string
  /**
   * Makes this tool the agent's runtime: while it is active, the model is offered this
   * tool alone (no other direct tool and no Code Mode `execute`), and its context
   * carries `runtime` to reach the rest. Deny the tool to give an agent its usual tools.
   * `describe` writes the description the model is offered from the tools it reaches.
   * `direct` names tools the model is also offered beside it, each with its own
   * definition, when the agent may use them; the runtime still reaches them too.
   */
  readonly runtime?:
    | boolean
    | {
        readonly describe?: (tools: ReadonlyArray<RuntimeTool>) => string
        readonly direct?: ReadonlyArray<string>
      }
}

export type Options = BaseOptions &
  (
    | {
        readonly codemode?: true
        readonly pinned?: boolean
      }
    | {
        readonly codemode: boolean
        readonly pinned?: never
      }
  )

export type ValueSchema<A = unknown> = Schema.Codec<A, any> | StandardSchemaV1<any, A> | JsonSchema.JsonSchema

type InputValue<S> = 0 extends 1 & S
  ? any
  : S extends Schema.Codec<infer A, any>
    ? A
    : S extends StandardSchemaV1<any, infer A>
      ? A
      : unknown
type OutputValue<S> = S extends undefined
  ? never
  : S extends Schema.Codec<infer A, any>
    ? A
    : S extends StandardSchemaV1<infer A, any>
      ? A
      : any

export class Error extends Schema.TaggedError<Error>()("Tool.Error", {
  message: Schema.String,
  error: Schema.optional(Schema.Defect()),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export interface TextContent extends Schema.Schema.Type<typeof TextContent> {}
export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
}).annotate({ identifier: "Tool.TextContent" })

export interface FileContent extends Schema.Schema.Type<typeof FileContent> {}
export const FileContent = Schema.Struct({
  type: Schema.Literal("file"),
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.optional(Schema.String),
}).annotate({ identifier: "Tool.FileContent" })

export const Content = Schema.Union([TextContent, FileContent])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Tool.Content" })
export type Content = Schema.Schema.Type<typeof Content>

export interface Result<Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined> {
  readonly output?: OutputValue<Output>
  readonly content?: string | ReadonlyArray<Content>
  readonly metadata?: Metadata
}

export type Info<
  Input extends ValueSchema<any> = ValueSchema<any>,
  Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined,
> = {
  readonly name: string
  readonly input: Input
  readonly description: string
  readonly execute: (input: InputValue<Input>, context: Context) => Effect.Effect<Result<Output>, Error>
  readonly output?: Output
  readonly options?: Options
}
