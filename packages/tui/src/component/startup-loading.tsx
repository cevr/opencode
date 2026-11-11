import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"

// Shown only when plugins take longer than half a second, and gone the moment they are loaded: the
// session under it is ready then, and a notice held on for a minimum time read as a startup still going.
export function StartupLoading(props: { ready: () => boolean }) {
  const theme = useTheme()
  const [show, setShow] = createSignal(false)
  let wait: NodeJS.Timeout | undefined

  createEffect(() => {
    if (props.ready()) {
      if (wait) {
        clearTimeout(wait)
        wait = undefined
      }
      setShow(false)
      return
    }
    if (show() || wait) return
    wait = setTimeout(() => {
      wait = undefined
      setShow(true)
    }, 500).unref()
  })

  onCleanup(() => {
    if (wait) clearTimeout(wait)
  })

  return (
    <Show when={show()}>
      <box position="absolute" zIndex={5000} left={0} right={0} bottom={1} justifyContent="center" alignItems="center">
        <box backgroundColor={theme.background.raised.base} paddingLeft={1} paddingRight={1}>
          <Spinner color={theme.text.muted}>Loading plugins…</Spinner>
        </box>
      </box>
    </Show>
  )
}
