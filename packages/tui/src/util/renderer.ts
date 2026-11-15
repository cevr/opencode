import { RendererControlState, type CliRenderer } from "@opentui/core"

type TitleRenderer = Pick<CliRenderer, "isDestroyed" | "controlState" | "setTerminalTitle">

// OpenTUI rejects terminal control from suspend() until resume() completes, e.g. while $EDITOR runs.
export function setTerminalTitle(renderer: TitleRenderer, title: string) {
  if (renderer.isDestroyed || renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED) return
  renderer.setTerminalTitle(title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " "))
}

// Leaving restores what the TUI set on the terminal: its title, and its OSC 7501 program status. Terminals drop
// working and blocked records when the process exits but keep idle, done and error ones, and a clear written by a
// finalizer after this point is dropped with the closing renderer, so every record goes here, whoever wrote it.
export function destroyRenderer(renderer: TitleRenderer & Pick<CliRenderer, "destroy" | "setProgramStatus">) {
  if (renderer.isDestroyed) return
  setTerminalTitle(renderer, "")
  renderer.setProgramStatus({ state: "clear" })
  renderer.destroy()
}
