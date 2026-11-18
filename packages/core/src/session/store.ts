export * as SessionStore from "./store.js"

import { and, asc, desc, eq, gt, isNotNull, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Project } from "@opencode/schema/project"
import { Workspace } from "@opencode/schema/workspace"
import { AbsolutePath, PositiveInt, RelativePath } from "@opencode/schema/schema"
import { Database } from "../database/database.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionHistory } from "./history.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { Session } from "@opencode/schema/session"
import { SessionMessageTable, SessionPartTable, SessionTable } from "./sql.js"
import { fromRow } from "./info.js"
import { SessionOutline } from "./outline.js"

const ListInputBase = {
  workspaceID: Workspace.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  parentID: Schema.NullOr(Session.ID).pipe(Schema.optional),
  archived: Schema.Boolean.pipe(Schema.optional),
  anchor: Session.ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

export type MessagesInput = {
  sessionID: Session.ID
  limit?: number
  order?: "asc" | "desc"
  type?: SessionMessage.Type
  cursor?: {
    id: SessionMessage.ID
    direction: "previous" | "next"
  }
}

/**
 * One message as a transcript map reads it: its kind and time, a one-line summary and an assistant step's counts,
 * never its body, so a whole session's outline costs a small fraction of its messages.
 */
export type OutlineEntry = {
  readonly id: SessionMessage.ID
  readonly type: SessionMessage.Type
  readonly time: number
  /** When an assistant step completed. */
  readonly completed?: number
  /**
   * At most {@link SessionOutline.SummaryLength} characters a reader knows the message by: a prompt's first line, a
   * notice's title, the first sentence of an assistant step's last text, a shell's command, a skill's name.
   */
  readonly summary?: string
  /** `metadata.source`, naming who sent a synthetic message (a subagent, a monitor, another session). */
  readonly source?: string
  /** An assistant step's tool calls. */
  readonly tools?: number
  /** An assistant step's thoughts: its reasoning parts with words in them. */
  readonly thoughts?: number
}

export interface Interface {
  readonly get: (sessionID: Session.ID) => Effect.Effect<Session.Info | undefined>
  readonly list: (input?: ListInput) => Effect.Effect<Session.Info[]>
  /**
   * Every Session under one, in a single read: breadth-first, and each parent's children newest
   * updated first (the order of `list({ parentID })`). The Session itself is not included.
   */
  readonly descendants: (sessionID: Session.ID) => Effect.Effect<Session.Info[]>
  readonly messages: (input: MessagesInput) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  /**
   * Every message of a session, oldest first, as {@link OutlineEntry}s; with `after`, only those after that message.
   * Undefined when `after` names no message of the session.
   */
  readonly outline: (input: {
    readonly sessionID: Session.ID
    readonly after?: SessionMessage.ID
  }) => Effect.Effect<OutlineEntry[] | undefined>
  readonly context: (sessionID: Session.ID) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  /**
   * The newest completed, error-free assistant message above the sequence
   * bound. Reads newest-first in pages so a long run of incomplete steps does
   * not decode the whole history.
   */
  readonly lastAssistantAfter: (input: {
    readonly sessionID: Session.ID
    readonly afterSeq?: number
  }) => Effect.Effect<SessionMessage.Assistant | undefined, MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.Info } | undefined>
  /** {@link Interface.messages} for clients that fetch media themselves: files stored in `blob` stay `media:` refs. */
  readonly messagesWithRefs: (input: MessagesInput) => Effect.Effect<SessionMessage.MediaInfo[], MessageDecodeError>
  /** {@link Interface.message} for clients that fetch media themselves. */
  readonly messageWithRefs: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.MediaInfo } | undefined>
  /**
   * Sessions holding an execution claim, including directly driven children.
   */
  readonly listSuspended: () => Effect.Effect<ReadonlyArray<Session.ID>>
  /**
   * Records the execution claim: the durable write-ahead intent that a turn is
   * (or was) in flight. Set when execution starts; a claim that survives to the
   * next boot marks a turn that never completed — its process crashed or shut
   * down mid-turn.
   */
  readonly claim: (sessionID: Session.ID) => Effect.Effect<void>
  /** Releases the claim and resets resume accounting. Terminal events call this on commit. */
  readonly release: (sessionID: Session.ID) => Effect.Effect<void>
  /**
   * Release abandoned claims when the child's parent was deleted.
   */
  readonly releaseOrphanedChildClaims: () => Effect.Effect<void>
  /**
   * Durably counts one more resume of an orphaned claim, returning the new
   * total — or undefined when the Session no longer exists.
   */
  readonly countResume: (sessionID: Session.ID) => Effect.Effect<number | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    /** One page of a session's message rows, oldest first within the page when paging backwards. */
    const messageRows = Effect.fnUntraced(function* (input: MessagesInput) {
      const direction = input.cursor?.direction ?? "next"
      const requestedOrder = input.order ?? "desc"
      const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
      const anchor = input.cursor
        ? yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      if (input.cursor && !anchor) return []
      const boundary = anchor
        ? order === "asc"
          ? gt(SessionMessageTable.seq, anchor.seq)
          : lt(SessionMessageTable.seq, anchor.seq)
        : undefined
      const query = db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            boundary,
            input.type === undefined ? undefined : eq(SessionMessageTable.type, input.type),
          ),
        )
        .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
      const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(Effect.orDie)
      return direction === "previous" ? rows.toReversed() : rows
    })

    const messageRow = (messageID: SessionMessage.ID) =>
      db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).get().pipe(Effect.orDie)

    return Service.of({
      get: Effect.fnUntraced(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      list: Effect.fn("SessionStore.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_updated
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if ("project" in input && input.subpath !== undefined) conditions.push(eq(SessionTable.path, input.subpath))
        if (input.search) conditions.push(sql`${SessionTable.title} GLOB ${titlePattern(input.search)}`)
        if (input.parentID !== undefined)
          conditions.push(
            input.parentID === null ? isNull(SessionTable.parent_id) : eq(SessionTable.parent_id, input.parentID),
          )
        if (input.archived !== undefined)
          conditions.push(input.archived ? isNotNull(SessionTable.time_archived) : isNull(SessionTable.time_archived))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      descendants: Effect.fn("SessionStore.descendants")(function* (sessionID) {
        // UNION, not UNION ALL: a parent cycle ends the walk instead of looping.
        const rows = yield* db
          .select()
          .from(SessionTable)
          .where(
            sql`${SessionTable.id} IN (WITH RECURSIVE family(id) AS (SELECT id FROM ${SessionTable} WHERE parent_id = ${sessionID} UNION SELECT child.id FROM ${SessionTable} AS child JOIN family ON child.parent_id = family.id) SELECT id FROM family)`,
          )
          .all()
          .pipe(Effect.orDie)
        const children = new Map<string, typeof rows>()
        for (const row of rows) {
          if (row.id === sessionID || !row.parent_id) continue
          const siblings = children.get(row.parent_id)
          if (siblings) siblings.push(row)
          else children.set(row.parent_id, [row])
        }
        // SQLite compares text bytewise; session ids are ASCII, so code-unit order matches it.
        for (const siblings of children.values())
          siblings.sort((a, b) =>
            a.time_updated !== b.time_updated
              ? b.time_updated - a.time_updated
              : a.id < b.id
                ? 1
                : a.id > b.id
                  ? -1
                  : 0,
          )
        const ordered: typeof rows = []
        const queue: string[] = [sessionID]
        for (let index = 0; index < queue.length; index++) {
          for (const child of children.get(queue[index]!) ?? []) {
            ordered.push(child)
            queue.push(child.id)
          }
        }
        return ordered.map((row) => fromRow(row))
      }),
      messages: Effect.fn("SessionStore.messages")(function* (input) {
        return yield* SessionHistory.decodeMessageRows(db, yield* messageRows(input))
      }),
      messagesWithRefs: Effect.fn("SessionStore.messagesWithRefs")(function* (input) {
        return yield* SessionHistory.decodeMessageRowsWithRefs(db, yield* messageRows(input))
      }),
      outline: Effect.fn("SessionStore.outline")(function* (input) {
        const anchor = input.after
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.after)))
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.after && !anchor) return undefined
        const message = SessionMessageTable
        const part = SessionPartTable
        // An assistant step's content lives in `session_part` rows, or inline in `data.content` for rows written
        // before parts were split out; a row an older build wrote to again holds both, read as the parts then the
        // inline content (SessionHistory), so its last text is the inline one's when there is one.
        const excerpt = SessionOutline.ExcerptLength
        const lastText = sql<string | null>`coalesce(
          (SELECT substr(json_extract(content.value, '$.text'), 1, ${excerpt})
            FROM json_each(${message.data}, '$.content') AS content
            WHERE json_extract(content.value, '$.type') = 'text'
              AND trim(coalesce(json_extract(content.value, '$.text'), '')) <> ''
            ORDER BY CAST(content.key AS INTEGER) DESC LIMIT 1),
          (SELECT substr(json_extract(${part.data}, '$.text'), 1, ${excerpt}) FROM ${part}
            WHERE ${part.message_id} = ${message.id} AND ${part.type} = 'text'
              AND trim(coalesce(json_extract(${part.data}, '$.text'), '')) <> ''
            ORDER BY ${part.ordinal} DESC LIMIT 1))`
        const count = (type: string, where: (value: SQL) => SQL = () => sql`1`) =>
          sql<number>`(SELECT count(*) FROM ${part}
              WHERE ${part.message_id} = ${message.id} AND ${part.type} = ${type} AND ${where(sql`${part.data}`)})
            + (SELECT count(*) FROM json_each(${message.data}, '$.content') AS content
              WHERE json_extract(content.value, '$.type') = ${type} AND ${where(sql`content.value`)})`
        // A thought the transcript shows has words in it: a redacted block alone renders nothing.
        const worded = (value: SQL) =>
          sql`trim(replace(coalesce(json_extract(${value}, '$.text'), ''), '[REDACTED]', '')) <> ''`
        const field = (path: string) =>
          sql<string | null>`substr(json_extract(${message.data}, ${path}), 1, ${excerpt})`
        const rows = yield* db
          .select({
            id: message.id,
            type: message.type,
            time: message.time_created,
            text: sql<string | null>`CASE ${message.type}
              WHEN 'assistant' THEN ${lastText}
              WHEN 'user' THEN ${field("$.text")}
              WHEN 'synthetic' THEN ${field("$.description")}
              WHEN 'system' THEN coalesce(${field("$.description")}, ${field("$.text")})
              WHEN 'shell' THEN ${field("$.command")}
              WHEN 'skill' THEN ${field("$.name")}
              END`,
            source: sql<string | null>`json_extract(${message.data}, '$.metadata.source')`,
            agent: sql<
              string | null
            >`CASE ${message.type} WHEN 'synthetic' THEN json_extract(${message.data}, '$.metadata.agent') END`,
            state: sql<
              string | null
            >`CASE ${message.type} WHEN 'synthetic' THEN json_extract(${message.data}, '$.metadata.state') END`,
            completed: sql<
              number | null
            >`CASE ${message.type} WHEN 'assistant' THEN json_extract(${message.data}, '$.time.completed') END`,
            tools: sql<number | null>`CASE ${message.type} WHEN 'assistant' THEN ${count("tool")} END`,
            thoughts: sql<number | null>`CASE ${message.type} WHEN 'assistant' THEN ${count("reasoning", worded)} END`,
          })
          .from(message)
          .where(and(eq(message.session_id, input.sessionID), anchor ? gt(message.seq, anchor.seq) : undefined))
          .orderBy(asc(message.seq))
          .all()
          .pipe(Effect.orDie)
        const text = (value: unknown) => (typeof value === "string" ? value : undefined)
        return rows.map((row): OutlineEntry => {
          const summary =
            row.type === "assistant"
              ? SessionOutline.firstSentence(row.text)
              : row.type === "synthetic"
                ? SessionOutline.noticeTitle({
                    description: row.text,
                    source: text(row.source),
                    agent: text(row.agent),
                    state: text(row.state),
                  })
                : row.type === "shell" || row.type === "skill"
                  ? SessionOutline.firstLine(row.text, { verbatim: true })
                  : SessionOutline.firstLine(row.text)
          return {
            id: row.id,
            type: row.type,
            time: row.time,
            ...(typeof row.completed === "number" ? { completed: row.completed } : {}),
            ...(summary ? { summary } : {}),
            ...(typeof row.source === "string" ? { source: row.source } : {}),
            ...(row.tools ? { tools: row.tools } : {}),
            ...(row.thoughts ? { thoughts: row.thoughts } : {}),
          }
        })
      }),
      context: Effect.fn("SessionStore.context")((sessionID) => SessionHistory.load(db, sessionID, "latest")),
      lastAssistantAfter: Effect.fn("SessionStore.lastAssistantAfter")(function* (input) {
        let cursorSeq: number | undefined
        while (true) {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, input.sessionID),
                eq(SessionMessageTable.type, "assistant"),
                input.afterSeq === undefined ? undefined : gt(SessionMessageTable.seq, input.afterSeq),
                cursorSeq === undefined ? undefined : lt(SessionMessageTable.seq, cursorSeq),
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(20)
            .all()
            .pipe(Effect.orDie)
          for (const message of yield* SessionHistory.decodeMessageRows(db, rows)) {
            if (message.type === "assistant" && message.time.completed !== undefined && message.error === undefined)
              return message
          }
          if (rows.length < 20) return undefined
          cursorSeq = rows[rows.length - 1]!.seq
        }
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* messageRow(messageID)
        if (!row) return undefined
        const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
        return message && { sessionID: row.session_id, message }
      }),
      messageWithRefs: Effect.fn("SessionStore.messageWithRefs")(function* (messageID) {
        const row = yield* messageRow(messageID)
        if (!row) return undefined
        const [message] = yield* SessionHistory.decodeMessageRowsWithRefs(db, [row]).pipe(Effect.orDie)
        return message && { sessionID: row.session_id, message }
      }),
      listSuspended: Effect.fn("SessionStore.listSuspended")(function* () {
        return yield* db
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(isNotNull(SessionTable.time_suspended))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => row.sessionID)),
          )
      }),
      claim: Effect.fn("SessionStore.claim")(function* (sessionID) {
        // The null guard makes re-claiming a still-claimed Session a zero-row
        // no-op (a resumed turn re-claims through the same started hook).
        // Claim bookkeeping never counts as user activity: time_updated is
        // pinned so session ordering only moves on real changes.
        yield* db
          .update(SessionTable)
          .set({ time_suspended: Date.now(), time_updated: sql`${SessionTable.time_updated}` })
          .where(and(eq(SessionTable.id, sessionID), isNull(SessionTable.time_suspended)))
          .run()
          .pipe(Effect.orDie)
      }),
      release: Effect.fn("SessionStore.release")(function* (sessionID) {
        yield* db
          .update(SessionTable)
          .set({ time_suspended: null, resume_attempts: 0, time_updated: sql`${SessionTable.time_updated}` })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
      releaseOrphanedChildClaims: Effect.fn("SessionStore.releaseOrphanedChildClaims")(() =>
        db
          .update(SessionTable)
          .set({ time_suspended: null, resume_attempts: 0, time_updated: sql`${SessionTable.time_updated}` })
          .where(
            and(
              isNotNull(SessionTable.time_suspended),
              notInArray(SessionTable.parent_id, db.select({ id: SessionTable.id }).from(SessionTable)),
            ),
          )
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
      ),
      countResume: Effect.fn("SessionStore.countResume")(function* (sessionID) {
        const row = yield* db
          .update(SessionTable)
          .set({
            resume_attempts: sql`${SessionTable.resume_attempts} + 1`,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(eq(SessionTable.id, sessionID))
          .returning({ attempts: SessionTable.resume_attempts })
          .get()
          .pipe(Effect.orDie)
        return row?.attempts
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

// SQLite's LIKE folds case for ASCII only, and none of our drivers (bun, node, Durable Objects) ships ICU or lets us
// register a lowercase function everywhere. GLOB is case-sensitive but supports character classes, so each cased
// letter becomes a class of its single-character case forms ("т" -> "[тТ]"). The LIKE wildcards % and _ keep their
// meaning, and GLOB metacharacters are wrapped in a class so they stay literal as they were under LIKE.
function titlePattern(search: string) {
  const chars = Array.from(search, (char) => {
    if (char === "%") return "*"
    if (char === "_") return "?"
    const cases = new Set(
      [char, char.toLowerCase(), char.toUpperCase()].filter((form) => Array.from(form).length === 1),
    )
    if (cases.size > 1) return `[${[...cases].join("")}]`
    return "*?[".includes(char) ? `[${char}]` : char
  })
  return `*${chars.join("")}*`
}
