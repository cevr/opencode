// Fork feature (synthetic-archived): finds every call in core's and the server's sources that admits input into a
// session (`synthetic(`, `.prompt(`, `.admit(`, `admitCompaction(`) and classifies it by SessionAdmission's table.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { SessionAdmission } from "@opencode/core/session/admission"

export type Site = { readonly file: string; readonly line: number; readonly call: string; readonly text: string }

const CALL = /(?<![A-Za-z0-9_"'`])(?:([A-Za-z_][\w.]*)\s*\.\s*)?(synthetic|prompt|admit|admitCompaction)\(/g
// Calls of the same names that admit nothing into a session.
const OTHER = /^(mcp|client|connection|AutomationEvent|input\.client\.session|Effect|this)$/

/** The argument text of the call whose `(` is at `open`. */
const argument = (source: string, open: number) => {
  let depth = 0
  for (let at = open; at < source.length; at++) {
    const char = source[at]
    if (char === "(") depth++
    if (char === ")" && --depth === 0) return source.slice(open + 1, at)
  }
  return source.slice(open + 1)
}

/** Every admission call in one file's text. */
export const sites = (file: string, source: string): Site[] =>
  [...source.matchAll(CALL)].flatMap((match) => {
    const receiver = (match[1] ?? "").replace(/\s+/g, "")
    const before = source.slice(Math.max(0, match.index - 30), match.index)
    // Declarations, not calls.
    if (/(const|function|let)\s+$/.test(before) || /\bfn\(\s*$/.test(before)) return []
    if (OTHER.test(receiver)) return []
    const open = match.index + match[0].length - 1
    return [
      {
        file,
        line: source.slice(0, match.index).split("\n").length,
        call: `${receiver ? `${receiver}.` : ""}${match[2]}`,
        text: argument(source, open),
      },
    ]
  })

/** How a site is classified: its named source, a plugin's (classified by the host), or unclassified. */
export const classify = (site: Site): string | undefined => {
  if (/^ctx\.session$/.test(site.call.replace(/\.(synthetic|prompt|admit)$/, ""))) return "plugin (host)"
  const named = /\bsource:\s*"([a-z]+)"/.exec(site.text)?.[1] ?? /rule\("([a-z]+)"\)/.exec(site.text)?.[1]
  if (named && named in SessionAdmission.Sources) return named
  return undefined
}

/** Every `.ts` file under `dir`, relative to `root`. */
export const files = (root: string, dir: string): string[] =>
  readdirSync(path.join(root, dir)).flatMap((name) => {
    const relative = path.join(dir, name)
    if (statSync(path.join(root, relative)).isDirectory()) return files(root, relative)
    return relative.endsWith(".ts") && !relative.endsWith(".test.ts") ? [relative] : []
  })

/** The unclassified sites per file in the tree (core and server sources). */
export const unclassified = (root: string) => {
  const counts = new Map<string, Site[]>()
  for (const dir of ["packages/core/src", "packages/server/src"])
    for (const file of files(root, dir))
      for (const site of sites(file, readFileSync(path.join(root, file), "utf8")))
        if (classify(site) === undefined) counts.set(file, [...(counts.get(file) ?? []), site])
  return counts
}
