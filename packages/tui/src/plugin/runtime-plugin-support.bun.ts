import { ensurePluginRuntime, provides } from "@opencode/plugin/runtime"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"
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

/**
 * OpenTUI's runtime modules by their bare specifiers. OpenTUI points a plugin's imports of these at the host's
 * instances by rewriting them in each file its onResolve sees, but Bun runs a runtime plugin's onResolve for a
 * relative import only, never for a bare one. A plugin's module reached through a package (a workspace package
 * linked into node_modules) kept its own imports and loaded `solid-js` from disk: a second Solid, whose
 * getOwner() is null inside the host's computations and whose signals the host never tracks. Registered as
 * modules, the bare specifiers resolve to OpenTUI's runtime modules from any importer, as ensurePluginRuntime
 * registers `effect` and `@opencode/plugin`.
 */
const HOST_MODULES = [
  "solid-js",
  "solid-js/store",
  "@opentui/core",
  "@opentui/solid",
  "@opentui/solid/components",
  "@opentui/solid/jsx-runtime",
  "@opentui/solid/jsx-dev-runtime",
] as const

Bun.plugin({
  name: "opencode-tui-host-modules",
  setup(build) {
    for (const specifier of HOST_MODULES)
      build.module(specifier, async () => ({ exports: await import(runtimeModuleIdForSpecifier(specifier)), loader: "object" }))
  },
})
