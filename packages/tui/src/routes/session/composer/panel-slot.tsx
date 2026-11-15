import { hasPlugins } from "../../../plugin/context"
import { Slot } from "../../../plugin/render"

/**
 * The composer panel's plugin slots. Upstream renders the panel with no PluginProvider in its own tests
 * (dialog-shell-output), so with no plugins a slot shows only the host's content, as a slot with no claims does.
 */
export const PanelSlot: typeof Slot = (props) => (hasPlugins() ? <Slot {...props} /> : props.children)
