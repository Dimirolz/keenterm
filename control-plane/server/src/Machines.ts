import { Effect, Schema } from "effect"
import { REPO_DIR } from "./config.js"
import { Sh } from "./Sh.js"

const MachineInfo = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
})
const MachineList = Schema.parseJson(Schema.Array(MachineInfo))
export type MachineInfo = typeof MachineInfo.Type

/** Typed wrapper over the host `orbctl` / `orb` CLIs. */
export class Machines extends Effect.Service<Machines>()("Machines", {
  dependencies: [Sh.Default],
  effect: Effect.gen(function* () {
    const { run } = yield* Sh

    return {
      list: run("orbctl", "list", "-f", "json").pipe(
        Effect.flatMap(Schema.decode(MachineList)),
        Effect.orDie,
      ),
      clone: (from: string, to: string) => run("orbctl", "clone", from, to),
      start: (machine: string) => run("orbctl", "start", machine),
      stop: (machine: string) => run("orbctl", "stop", machine),
      delete: (machine: string) => run("orbctl", "delete", machine),
      /** Run a command inside the VM's repo checkout with asdf on PATH. */
      runInRepo: (machine: string, script: string) =>
        run("orb", "-m", machine, "bash", "-lc", `. ~/.asdf/asdf.sh && cd ${REPO_DIR} && ${script}`),
    }
  }),
}) {}
