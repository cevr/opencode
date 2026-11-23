export * as UserCommand from "./user-command.js"

// Fork feature (synthetic-archived): the provenance of a slash command the user typed. The server sets it around the
// user's own `session.command` call; the plugin host reads it when a command's execute prompts its session, so the
// user's command counts as the user's prompt while every other plugin input stays a plugin's (core
// session/admission.ts). Every command's execute runs under a mark of its own (its extent, `commandExtent` there);
// only one the user typed covers its session. It is a fiber-local value, never an argument a plugin can pass, and it
// closes when the command's execute returns: work the command left running (a fork, a timer, a hook) finds it closed.

import { Context } from "effect"

export type Mark = {
  /** The session the command runs on. Input to any other session is not the user's. */
  readonly sessionID: string
  /** Whether the user typed it (the server's route); a command a plugin or an automation runs is not the user's. */
  readonly user: boolean
  /** Until the command's execute returns. */
  open: boolean
}

export const Current = Context.Reference<Mark | undefined>("@opencode/UserCommand/Current", {
  defaultValue: () => undefined,
})

/** Whether input to `sessionID` now is the user's own command's. */
export const covers = (mark: Mark | undefined, sessionID: string) =>
  mark !== undefined && mark.user && mark.open && mark.sessionID === sessionID
