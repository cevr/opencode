import { TextAttributes, type MarkdownInlineHook, type MarkdownInlineSpan, type MarkdownRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createSignal, untrack } from "solid-js"
import { parseSessionMention, sessionMentions } from "@opencode/util/session-mention"
import { displayLabel } from "@opencode/util/session-title-fallback"
import { useData } from "../context/data"
import { useRoute } from "../context/route"
import { useDialog } from "./dialog"
import { plainClick } from "./link"

/**
 * Returns a `<markdown>` ref that shows session IDs as links titled after their sessions and
 * opens them on click, like the web app. The current session, archived sessions and sessions
 * that cannot be loaded stay plain IDs. Links re-render when a label changes.
 */
export function useSessionLinks() {
  const data = useData()
  const route = useRoute()
  const dialog = useDialog()
  const renderer = useRenderer()
  const labelOf = (sessionID: string) => {
    if (route.data.type === "session" && route.data.sessionID === sessionID) return
    const session = data.session.get(sessionID)
    return session && session.time.archived === undefined ? displayLabel(session) : undefined
  }
  // Only the hook asks for unknown sessions, when a block shows an ID; the effect below just watches labels.
  // Sync dedupes in-flight and finished loads, and a miss marks the session missing.
  const load = (sessionID: string) => {
    if (route.data.type === "session" && route.data.sessionID === sessionID) return
    if (data.session.get(sessionID) || data.session.missing(sessionID)) return
    void data.session.sync(sessionID).catch(() => undefined)
  }
  // Labels each ID was last rendered with, so the effect below re-renders only on a change.
  const used = new Map<string, string | undefined>()
  const [version, setVersion] = createSignal(0)
  let markdown: MarkdownRenderable | undefined

  // OpenTUI runs the hook on the spans of each prose block and table cell that mentions `ses_`, inside
  // whatever setter changed the content, so reading labels must not subscribe that setter's owner.
  const linkSpans: MarkdownInlineHook = (spans, context) =>
    untrack(() => {
      const style = context.syntaxStyle.mergeStyles("markup.link.url")
      return spans.flatMap((span): MarkdownInlineSpan[] => {
        // Like the web app, a code span links only when it is exactly a session ID, so a command such
        // as `opencode --session ses_…` stays copyable.
        if (span.link) return [span]
        if (span.code && !parseSessionMention(span.text.replace(/^`+\s?|\s?`+$/g, ""))) return [span]
        const mentions = sessionMentions(span.text)
        if (mentions.length === 0) return [span]
        // Odd parts are the mentions.
        const cuts = [0, ...mentions.flatMap((mention) => [mention.start, mention.end]), span.text.length]
        return cuts.slice(1).flatMap((end, index) => {
          const text = span.text.slice(cuts[index], end)
          const mention = index % 2 ? mentions[(index - 1) / 2]! : undefined
          if (mention) load(mention.id)
          const label = mention && labelOf(mention.id)
          if (mention && (!used.has(mention.id) || used.get(mention.id) !== label)) {
            used.set(mention.id, label)
            setVersion((value) => value + 1)
          }
          if (!mention || label === undefined) return text ? [{ ...span, text }] : []
          return [
            {
              ...span,
              // Raw markdown mode shows the source.
              text: context.conceal ? `@${label}` : text,
              fg: style.fg ?? span.fg,
              attributes: (style.attributes ?? 0) | TextAttributes.UNDERLINE,
              target: mention.id,
            },
          ]
        })
      })
    })

  createEffect(() => {
    version()
    const changed = [...used].flatMap(([sessionID, label]) => (labelOf(sessionID) === label ? [] : [sessionID]))
    if (!markdown || changed.length === 0) return
    changed.forEach((sessionID) => used.set(sessionID, labelOf(sessionID)))
    // Rewrites only the blocks that mention a changed session; nothing is parsed or highlighted again.
    untrack(() => markdown!.rerunInlineHook((source) => changed.some((sessionID) => source.includes(sessionID))))
  })

  return (renderable: MarkdownRenderable) => {
    markdown = renderable
    renderable.inlineHookFilter = ["ses_"]
    renderable.inlineHook = linkSpans
    renderable.onMouseUp = (event) => {
      if (!plainClick(renderer, event)) return
      const sessionID = renderable.targetAt(event.x, event.y)
      if (!sessionID) return
      event.stopPropagation()
      if (dialog.stack.length > 0) dialog.clear()
      route.navigate({ type: "session", sessionID })
    }
  }
}
