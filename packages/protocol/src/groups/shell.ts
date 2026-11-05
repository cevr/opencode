import { Shell } from "@opencode/schema/shell"
import { Location } from "@opencode/schema/location"
import { Schema, SchemaGetter } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ShellNotFoundError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

export const ShellGroup = HttpApiGroup.make("server.shell")
  .add(
    HttpApiEndpoint.get("shell.list", "/api/shell", {
      query: Schema.Struct({ ...LocationQuery.fields, exited: BooleanFromString.pipe(Schema.optional) }),
      success: Location.response(Schema.Array(Shell.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "shell.list",
          summary: "List shell commands",
          description:
            "List currently running shell commands for a location. With exited=true, also the recently exited commands still retained, oldest first.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("shell.create", "/api/shell", {
      query: LocationQuery,
      payload: Shell.CreateInput,
      success: Location.response(Shell.Info),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "shell.create",
          summary: "Run shell command",
          description:
            "Spawn one non-interactive shell command for a location. Combined stdout/stderr is captured to a file pageable via output.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("shell.get", "/api/shell/:id", {
      params: { id: Shell.ID },
      query: LocationQuery,
      success: Location.response(Shell.Info),
      error: ShellNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "shell.get",
          summary: "Get shell command",
          description: "Get one shell command, including its status and exit code once exited.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("shell.output", "/api/shell/:id/output", {
      params: { id: Shell.ID },
      query: Schema.Struct({ ...LocationQuery.fields, ...Shell.OutputInput.fields }),
      success: Location.response(Shell.Output),
      error: ShellNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "shell.output",
          summary: "Read shell output",
          description: "Page through captured combined output by absolute byte cursor.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("shell.kill", "/api/shell/:id/kill", {
      params: { id: Shell.ID },
      query: LocationQuery,
      success: Location.response(Shell.Info),
      error: ShellNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "shell.kill",
          summary: "Kill shell command",
          description:
            "End one running shell command: SIGTERM to its process group, then SIGKILL to what is left after a grace period. Its record and output stay readable. Returns its terminal state.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("shell.remove", "/api/shell/:id", {
      params: { id: Shell.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "shell.remove",
          summary: "Remove shell command",
          description: "Terminate and remove one shell command and its retained output.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "shell", description: "Location-scoped shell command routes." }),
  )
