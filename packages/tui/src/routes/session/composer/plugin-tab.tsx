import { onCleanup, onMount, Show } from "solid-js"
import type { ComposerTab } from "@opencode/plugin/tui/context"
import { useComposerTab } from "./context"

/** A plugin's tab (`ui.composerTab`): registered while mounted, its content mounted only while it is the active tab. */
export function PluginTab(props: { tab: ComposerTab; sessionID: string }) {
  const composer = useComposerTab()

  onMount(() => {
    const cleanup = composer.register({
      id: props.tab.id,
      label: props.tab.title,
      hints: () => [...(props.tab.hints?.() ?? [])],
    })
    onCleanup(cleanup)
  })

  return (
    <Show when={composer.active(props.tab.id)}>
      {props.tab.render({ sessionID: props.sessionID, close: composer.close })}
    </Show>
  )
}
