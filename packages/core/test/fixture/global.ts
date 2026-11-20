import path from "path"
import { Global } from "@opencode/util/global"
import { Effect, Layer } from "effect"
import { tmpdir } from "./tmpdir"

/** Global paths in a scratch folder; `home` replaces the scratch home for a test about the home folder itself. */
export const tempGlobal = (options?: { readonly home?: string }) =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.map((tmp) => {
        const data = path.join(tmp.path, "data")
        const cache = path.join(tmp.path, "cache")
        return Global.layerWith({
          // A scratch home, so nothing under the real one (~/.claude/CLAUDE.md) reaches a test.
          home: options?.home ?? path.join(tmp.path, "home"),
          data,
          cache,
          config: path.join(tmp.path, "config"),
          state: path.join(tmp.path, "state"),
          tmp: path.join(tmp.path, "tmp"),
          bin: path.join(cache, "bin"),
          log: path.join(data, "log"),
          repos: path.join(data, "repos"),
        })
      }),
    ),
  )

export const tempGlobalLayer = tempGlobal()
