import { EOL } from "os"
import { Effect } from "effect"
import { Service } from "@opencode/client/effect/service"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  Commands.commands.service.commands.restart,
  Effect.fn("cli.service.restart")(function* () {
    const options = yield* ServiceConfig.options()
    // A restart hands the process daemon to the next server, as a client's restart does: its shell commands and
    // persistent terminals keep running, and the next server takes them back.
    yield* Service.stop({ ...options, pty: "handoff" })
    const transport = yield* Service.ensure(options)
    process.stdout.write(transport.url + EOL)
  }),
)
