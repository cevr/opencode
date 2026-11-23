// Fork feature (synthetic-archived): over HTTP, an archived session refuses a client's synthetic message with 409 (the
// client keeps it; no row is admitted), and the user's own slash command on it is the user's prompt, admitted.
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

it.live("an archived session answers a client's synthetic message 409 and admits the user's own /init", () =>
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

    const synthetic = yield* post(`/api/session/${session.id}/synthetic`, { text: "a client's notice", resume: false })
    expect(synthetic.status).toBe(409)
    expect(yield* Effect.promise(() => synthetic.text())).toContain("archived")
    expect(yield* sessions.inbox(session.id)).toEqual([])

    // The user typed /init: the built-in command's prompt is the user's, admitted into the archived session.
    const command = yield* post(`/api/session/${session.id}/command`, { name: "init", text: "" })
    expect(command.status).toBeLessThan(300)
    expect((yield* sessions.inbox(session.id)).map((item) => item.type)).toEqual(["user"])
  }),
)
