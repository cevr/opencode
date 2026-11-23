// Fork feature (synthetic-archived): over HTTP, an archived session holds a client's synthetic message (the route
// cannot tell its callers apart: ACP's own turn context, an SDK script) unwoken and says so (`held: true`, additive),
// and the user's own slash command on it is the user's prompt, admitted.
import { expect } from "bun:test"
import { App } from "@opencode/core/app"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { ModelsDev } from "@opencode/core/models-dev"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

it.live("an archived session holds a client's synthetic message, says so, and admits the user's own /init", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const location = LocationServiceMap.canonical(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))
    const replacements: LayerNode.Replacements = [
      Global.node.replace(tempGlobalLayer),
      Database.node.replace(Database.node),
      Bus.node.replace(Bus.node),
      App.node.replace(App.node),
      ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ]
    const context = yield* Layer.build(
      createEmbeddedRoutes({}, replacements).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const sessions = Context.get(context, Session.Service)
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const post = (route: string, body: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${route}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      )

    const session = yield* sessions.create({ location, title: "archived" })
    yield* sessions.archive(session.id)

    // As ACP's turn sends its embedded context: held (admitted, not woken), and the response says so.
    const synthetic = yield* post(`/api/session/${session.id}/synthetic`, {
      text: "ACP embedded context",
      delivery: "steer",
      resume: false,
    })
    expect(synthetic.status).toBe(200)
    const body = (yield* Effect.promise(() => synthetic.json())) as { data: { type: string; held?: boolean } }
    expect(body.data).toMatchObject({ type: "synthetic", held: true })
    expect((yield* sessions.inbox(session.id)).map((item) => item.type)).toEqual(["synthetic"])

    // A live session's answer is upstream's shape: no `held`.
    const live = yield* sessions.create({ location, title: "live" })
    const admitted = yield* post(`/api/session/${live.id}/synthetic`, { text: "a note", resume: false })
    expect(admitted.status).toBe(200)
    expect(((yield* Effect.promise(() => admitted.json())) as { data: object }).data).not.toHaveProperty("held")

    // A deleted session: 404, as before.
    yield* sessions.remove(live.id)
    expect((yield* post(`/api/session/${live.id}/synthetic`, { text: "late", resume: false })).status).toBe(404)

    // The user typed /init: the built-in command's prompt is the user's, admitted into the archived session.
    const command = yield* post(`/api/session/${session.id}/command`, { name: "init", text: "" })
    expect(command.status).toBeLessThan(300)
    expect((yield* sessions.inbox(session.id)).map((item) => item.type)).toEqual(["synthetic", "user"])
  }),
)
