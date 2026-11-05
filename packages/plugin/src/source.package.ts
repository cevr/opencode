import { existsSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"

export function missingPackageTarget(specifier: string, importer: string) {
  if (specifier.startsWith("#")) return undefined
  const parts = specifier.split("/")
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
  const start = path.dirname(importer)
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, "package.json"))) return path.join(directory, "node_modules", name)
    if (path.dirname(directory) === directory) return path.join(start, "node_modules", name)
  }
}

// The workspace a plugin entrypoint belongs to: the nearest directory above it
// whose package.json declares workspaces (npm, Yarn, Bun) or that holds a
// pnpm-workspace.yaml. Undefined when the plugin is not part of a workspace.
export function workspaceRoot(entry: string) {
  for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, "pnpm-workspace.yaml"))) return real(directory)
    const manifest = (() => {
      try {
        return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as unknown
      } catch {
        return undefined
      }
    })()
    if (typeof manifest === "object" && manifest !== null && "workspaces" in manifest) return real(directory)
    if (path.dirname(directory) === directory) return undefined
  }
}

// A package file is plugin source when it is a package of the plugin's own
// workspace: the package manager links it into node_modules, but its real path
// lies inside the workspace and outside every node_modules, where the owner
// edits it. Installed packages, and checkouts linked from elsewhere (which the
// host may have loaded itself), stay external so they keep one shared
// instance. Returns the real path to watch and reload.
export function linkedPackageSource(resolved: string, workspace: string | undefined) {
  if (!workspace || !path.isAbsolute(resolved)) return undefined
  const file = real(resolved)
  if (!file) return undefined
  const inside = path.relative(workspace, file)
  if (
    inside === ".." ||
    inside.startsWith(".." + path.sep) ||
    path.isAbsolute(inside) ||
    inside.split(path.sep).includes("node_modules")
  )
    return undefined
  return file
}

function real(file: string) {
  try {
    return realpathSync(file)
  } catch {
    return undefined
  }
}
