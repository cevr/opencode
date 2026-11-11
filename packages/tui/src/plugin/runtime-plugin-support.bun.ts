import { ensurePluginRuntime, provides } from "@opencode/plugin/runtime"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { Global } from "@opencode/util/global"
import path from "node:path"
import { buildVersion, installCachedSolidTransform } from "./solid-transform-cache"

ensurePluginRuntime()
const version = buildVersion()
if (version) installCachedSolidTransform(path.join(Global.Path.cache, "solid-transform"), version)
ensureRuntimePluginSupport({
  additional: {
    "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin },
  },
  preserve: provides,
})
