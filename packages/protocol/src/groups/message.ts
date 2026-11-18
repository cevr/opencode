import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Location } from "@opencode/schema/location"
import { Schema, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidCursorError, SessionNotFoundError, UnknownError } from "../errors.js"

// Keyed by message type so a new message type cannot be left out of the filter.
const MessageTypes = {
  "agent-switched": true,
  "model-switched": true,
  "location-switched": true,
  user: true,
  synthetic: true,
  system: true,
  skill: true,
  shell: true,
  assistant: true,
  compaction: true,
  idle: true,
} satisfies Record<SessionMessage.Type, true>

export const SessionMessagesQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ).annotate({
    description: "Maximum number of messages to return. When omitted, the endpoint returns its default page size.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Message order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  cursor: Schema.optional(
    Schema.String.annotate({
      description:
        "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response. Do not combine with order.",
    }),
  ),
  type: Schema.optional(Schema.Literals(Object.keys(MessageTypes) as ReadonlyArray<SessionMessage.Type>)).annotate({
    description:
      "Filter by message type before pagination. When omitted, all message types are returned. Pass the same type when following cursors.",
  }),
}).annotate({ identifier: "SessionMessagesQuery" })

const PublicLocationSwitched = Schema.Struct({
  ...Struct.omit(SessionMessage.LocationSwitched.fields, ["location", "previous"]),
  location: Location.PublicRef,
  previous: Schema.Struct({
    location: Location.PublicRef,
    projectID: SessionMessage.LocationSwitched.fields.projectID,
    subpath: SessionMessage.LocationSwitched.fields.subpath,
  }).pipe(Schema.optional),
}).annotate({ identifier: "Session.Message.LocationSwitched" })

export const PublicSessionMessage = Schema.Union([
  SessionMessage.AgentSelected,
  SessionMessage.ModelSelected,
  PublicLocationSwitched,
  SessionMessage.User,
  SessionMessage.Synthetic,
  SessionMessage.System,
  SessionMessage.Skill,
  SessionMessage.Shell,
  SessionMessage.Assistant,
  SessionMessage.Compaction,
  SessionMessage.Idle,
]).annotate({ identifier: "Session.Message.Info" })

/**
 * Experimental: {@link PublicSessionMessage} as sent to clients that opt in with `X-OpenCode-Capabilities:
 * experimental-media-uri` while `experimental.media_blob` is on. User files stored in `blob` stay `media:` refs.
 */
export const PublicMediaSessionMessage = Schema.Union([
  SessionMessage.AgentSelected,
  SessionMessage.ModelSelected,
  PublicLocationSwitched,
  SessionMessage.MediaUser,
  SessionMessage.Synthetic,
  SessionMessage.System,
  SessionMessage.Skill,
  SessionMessage.Shell,
  SessionMessage.Assistant,
  SessionMessage.Compaction,
  SessionMessage.Idle,
]).annotate({ identifier: "Session.Message.MediaInfo" })

const MessagesCursor = Schema.Struct({
  previous: Schema.String.pipe(Schema.optional),
  next: Schema.String.pipe(Schema.optional),
})

/** Experimental: the `session.messages` response for clients that opt into `experimental-media-uri`. */
export const SessionMediaMessagesResponse = Schema.Struct({
  data: Schema.Array(PublicMediaSessionMessage),
  cursor: MessagesCursor,
})

/** Experimental: the `session.message` response for clients that opt into `experimental-media-uri`. */
export const SessionMediaMessageResponse = Schema.Struct({ data: PublicMediaSessionMessage })

export const SessionOutlineQuery = Schema.Struct({
  after: Schema.optional(SessionMessage.ID).annotate({
    description: "Return only the messages after this one, to extend an outline read before.",
  }),
}).annotate({ identifier: "SessionOutlineQuery" })

export const SessionOutlineEntry = Schema.Struct({
  id: SessionMessage.ID,
  type: Schema.Literals(Object.keys(MessageTypes) as ReadonlyArray<SessionMessage.Type>),
  time: Schema.Number.annotate({ description: "When the message was created, in epoch milliseconds." }),
  text: Schema.optional(Schema.String).annotate({
    description:
      "The start of the text the message is known by: a prompt's text, a notice's description, an assistant step's first text, a shell's command, a skill's name.",
  }),
  source: Schema.optional(Schema.String).annotate({ description: "Who sent a synthetic message (`metadata.source`)." }),
  tools: Schema.optional(Schema.Number).annotate({ description: "An assistant step's tool calls." }),
}).annotate({ identifier: "SessionOutlineEntry" })

export const MessageGroup = HttpApiGroup.make("server.message")
  .add(
    HttpApiEndpoint.get("session.messages", "/api/session/:sessionID/message", {
      params: { sessionID: Session.ID },
      query: SessionMessagesQuery,
      success: Schema.Struct({
        data: Schema.Array(PublicSessionMessage),
        cursor: MessagesCursor,
      }).annotate({ identifier: "SessionMessagesResponse" }),
      error: [InvalidCursorError, SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.message.list",
        summary: "Get session messages",
        description:
          "Retrieve projected messages for a session, optionally filtered by type. Items keep the requested order across pages; use cursor.next or cursor.previous to move through the ordered timeline, passing the same type filter on each page.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("session.outline", "/api/session/:sessionID/outline", {
      params: { sessionID: Session.ID },
      query: SessionOutlineQuery,
      success: Schema.Struct({ data: Schema.Array(SessionOutlineEntry) }).annotate({
        identifier: "SessionOutlineResponse",
      }),
      error: [InvalidCursorError, SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.message.outline",
        summary: "Get a session's outline",
        description:
          "Every message of a session, oldest first, without its body: its type, time, and a short excerpt of its text. A transcript map reads a long session from it at a small fraction of the cost of its messages.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "session",
      description: "Experimental message routes.",
    }),
  )
