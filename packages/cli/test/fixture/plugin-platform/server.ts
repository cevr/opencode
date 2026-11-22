// A local plugin with no node_modules of its own: it imports only what the host serves and requires only the services
// the host provides. The compiled smoke loads it to prove the loader and the host's Effect instance agree.
import { Plugin } from "@opencode/plugin/effect"
import { Effect, FileSystem, Path } from "effect"
import { Digest } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// SHA-256 of input.txt's exact bytes.
const expected = "dc806608c86323e81e67cbe22ed3df62c4d8c516f042be70740bc0f1d162b256"

export default Plugin.define({
  id: "platform-probe",
  effect: () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const input = yield* paths.fromFileUrl(new URL("./input.txt", import.meta.url))
      const bytes = yield* fs.readFile(input)
      if (new TextDecoder().decode(bytes) !== "platform probe input\n") return yield* Effect.die("read the wrong bytes")
      // Digest is not a host service: a plugin provides the WebCrypto implementation from `effect/crypto` itself.
      const digest = yield* Digest.Digest.use((digest) => digest.digest(Digest.sha256, bytes)).pipe(
        Effect.provide(Digest.layerWebCrypto),
      )
      const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
      if (hex !== expected) return yield* Effect.die(`digest ${hex} is not ${expected}`)
      // The host's own executable runs as Bun (compiled) or Node, so the child needs nothing on PATH on any platform.
      const output = yield* spawner.string(
        ChildProcess.make(process.execPath, ["-e", "process.stdout.write('platform-probe')"], {
          env: { BUN_BE_BUN: "1" },
          extendEnv: true,
        }),
      )
      if (output !== "platform-probe") return yield* Effect.die(`child wrote ${JSON.stringify(output)}`)
    }).pipe(Effect.orDie),
})
