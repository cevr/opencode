import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../../context/theme"
import { SplitBorder } from "../../../ui/border"
import { Keymap } from "../../../context/keymap"
import { SubagentsTab } from "./subagents-tab"
import { ShellTab } from "./shell-tab"
import { ScriptsTab } from "./scripts-tab"
import { TerminalsTab } from "./terminals-tab"
import { PluginTab } from "./plugin-tab"
import type { ComposerTab as PluginComposerTab } from "@opencode/plugin/tui/context"
import { ComposerContext } from "./context"
import { createComposerTabs } from "./tabs"
import { PanelSlot as Slot } from "./panel-slot"

export type ComposerProps = {
  sessionID: string
  open: boolean
  defaultTab?: string
  onClose?: () => void
  /** What Escape, Ctrl+C and the `esc` label do: just put the panel away; onClose when absent. A tab's own close (Up past the first row) stays onClose. */
  onDismiss?: () => void
  terminals?: boolean
  visibleTerminalID?: string
  /** Plugin tabs (`ui.composerTab`), after the host's; the mount site reads them from the plugin registry. */
  pluginTabs?: readonly PluginComposerTab[]
}

export function Composer(props: ComposerProps) {
  const theme = useTheme()

  const tabs = createComposerTabs({ open: () => props.open, defaultTab: () => props.defaultTab })
  const tabList = tabs.list
  const activeTab = createMemo(() => tabList().find((t) => t.id === tabs.active()))
  const footerHints = createMemo(() => activeTab()?.hints?.() ?? [])

  function close() {
    props.onClose?.()
  }

  function dismiss() {
    if (props.onDismiss) props.onDismiss()
    else close()
  }

  const ctx = {
    register: tabs.register,
    active(id: string) {
      return props.open && tabs.active() === id
    },
    close,
  }

  const keymap = Keymap.use()
  createEffect(() => {
    if (!props.open) return
    const popMode = keymap.mode.push("composer")
    onCleanup(popMode)
  })

  const switchTab = (dir: number) => {
    const list = tabList()
    if (list.length <= 1) return
    const idx = list.findIndex((t) => t.id === tabs.active())
    tabs.setActive(list[(idx + dir + list.length) % list.length].id)
  }

  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => props.open,
    priority: 1,
    commands: [
      { bind: "left", title: "Previous tab", group: "Composer", run: () => switchTab(-1) },
      { bind: "right", title: "Next tab", group: "Composer", run: () => switchTab(1) },
      { bind: "escape", title: "Close composer", group: "Composer", run: dismiss },
      { bind: "ctrl+c", title: "Close composer", group: "Composer", run: dismiss },
    ],
  }))

  return (
    <ComposerContext.Provider value={ctx}>
      <box flexShrink={0} visible={props.open}>
        <box
          {...SplitBorder}
          border={["left"]}
          borderColor={theme.border.base}
          backgroundColor={theme.background.raised.base}
          paddingLeft={1}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <box gap={1}>
            <Slot
              path="session.composer.panel.tabs"
              input={{
                sessionID: props.sessionID,
                get open() {
                  return props.open
                },
                get tabs() {
                  return tabList().map((tab) => ({ id: tab.id, label: tab.label }))
                },
                get active() {
                  return tabs.active()
                },
                select: (id: string) => tabs.setActive(id),
                dismiss,
              }}
            >
              <box flexDirection="row" justifyContent="space-between" paddingLeft={1}>
                <Show
                  when={tabList().length > 1}
                  fallback={
                    <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                      {tabList()[0]?.label ?? ""}
                    </text>
                  }
                >
                  <box flexDirection="row" gap={2}>
                    <For each={tabList()}>
                      {(t) => {
                        const isActive = createMemo(() => tabs.active() === t.id)
                        return (
                          <text
                            fg={isActive() ? theme.text.base : theme.text.muted}
                            attributes={isActive() ? TextAttributes.BOLD : undefined}
                            onMouseUp={() => tabs.setActive(t.id)}
                          >
                            {t.label}
                          </text>
                        )
                      }}
                    </For>
                  </box>
                </Show>
                <text fg={theme.text.muted} onMouseUp={dismiss}>
                  esc
                </text>
              </box>
            </Slot>
            <SubagentsTab sessionID={props.sessionID} />
            <ShellTab sessionID={props.sessionID} />
            <ScriptsTab sessionID={props.sessionID} />
            <Show when={props.terminals}>
              <TerminalsTab sessionID={props.sessionID} visibleTerminalID={props.visibleTerminalID} />
            </Show>
            <For each={props.pluginTabs ?? []}>{(tab) => <PluginTab tab={tab} sessionID={props.sessionID} />}</For>
            <Slot
              path="session.composer.panel.footer"
              input={{
                sessionID: props.sessionID,
                get hints() {
                  return footerHints()
                },
                get tabs() {
                  return tabList().length
                },
              }}
            >
              <box flexDirection="row" gap={2} paddingLeft={1} flexShrink={0}>
                <For each={footerHints()}>
                  {(hint) => (
                    <text>
                      <span style={{ fg: theme.text.base }}>
                        <b>{hint.label}</b>{" "}
                      </span>
                      <span style={{ fg: theme.text.muted }}>{hint.shortcut}</span>
                    </text>
                  )}
                </For>
                <Show when={tabList().length > 1}>
                  <text>
                    <span style={{ fg: theme.text.base }}>
                      <b>tabs</b>{" "}
                    </span>
                    <span style={{ fg: theme.text.muted }}>←/→</span>
                  </text>
                </Show>
              </box>
            </Slot>
          </box>
        </box>
      </box>
    </ComposerContext.Provider>
  )
}
