// The build an install put in place on this machine, as the install records it in `<state>/installed.json`:
// its version, the command that runs it, and the versions it replaced. Builds of one release (`2.2.7-prime.<commit>`)
// carry no order among themselves, so this record is what tells a newer build from an older one: a build listed in
// `previous` is one the installed build superseded. A TUI moves onto the installed build only from a build it
// superseded, and a client of a superseded build starts the background service on the installed build, never on
// its own. Without the file nothing moves, and every client starts the service on its own build as before.
import { accessSync, constants, readFileSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"

export const Info = Schema.Struct({
  version: Schema.String,
  command: Schema.NonEmptyArray(Schema.String),
  previous: Schema.optional(Schema.Array(Schema.String)),
})
export type Info = typeof Info.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Info))

export const file = (state: string) => path.join(state, "installed.json")

/** The installed build's record, when there is one, it is well formed and its executable runs. */
export function read(state: string): Info | undefined {
  const text = (() => {
    try {
      return readFileSync(file(state), "utf8")
    } catch {
      return undefined
    }
  })()
  const info = text === undefined ? undefined : Option.getOrUndefined(decode(text))
  if (!info) return undefined
  try {
    accessSync(info.command[0], constants.X_OK)
  } catch {
    return undefined
  }
  return info
}

/** Whether the installed build superseded `version`: `version` is a build installed before it. */
export function supersedes(info: Info | undefined, version: string): info is Info {
  return info !== undefined && info.version !== version && (info.previous ?? []).includes(version)
}

export * as InstalledBuild from "./installed-build.js"
