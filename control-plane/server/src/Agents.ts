import { Data, Effect } from "effect"
import * as Codex from "./Codex.js"
import { BASE_MACHINE, hasuraPort, MACHINE_RE, machineFor, pgPort, redisPort } from "./config.js"
import { Hasura, type StackStatus } from "./Hasura.js"
import { Machines } from "./Machines.js"

export class MachineNotFound extends Data.TaggedError("MachineNotFound")<{
  readonly machine: string
}> {}

export interface AgentInfo {
  readonly n: number
  readonly name: string
  readonly state: string
  readonly codex: boolean
  readonly working: boolean
  readonly stack: StackStatus
}

const NO_STACK: StackStatus = { pg: false, redis: false, hasura: false }

/** Agent lifecycle. State is always derived live from orbctl + docker + pty sessions. */
export class Agents extends Effect.Service<Agents>()("Agents", {
  dependencies: [Machines.Default, Hasura.Default],
  effect: Effect.gen(function* () {
    const machines = yield* Machines
    const hasura = yield* Hasura

    const list: Effect.Effect<Array<AgentInfo>, never, never> = Effect.all(
      [machines.list, hasura.statusAll],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([all, stacks]) =>
        all
          .flatMap((m) => {
            const match = MACHINE_RE.exec(m.name)
            if (!match) return []
            const n = Number(match[1])
            return [{
              n,
              name: m.name,
              state: m.state,
              stack: stacks.get(n) ?? NO_STACK,
              ...Codex.sessionStatus(m.name),
            }]
          })
          .sort((a, b) => a.n - b.n),
      ),
      Effect.orDie,
    )

    const requireAgent = (n: number) =>
      list.pipe(
        Effect.flatMap((agents) => {
          const agent = agents.find((a) => a.n === n)
          return agent ? Effect.succeed(agent) : Effect.fail(new MachineNotFound({ machine: machineFor(n) }))
        }),
      )

    /** Host containers + per-agent .env in the VM. Does NOT start the backend —
     * codex runs `pnpm backend:web` itself when it needs the live stack. */
    const provision = (n: number) =>
      Effect.gen(function* () {
        yield* hasura.up(n)
        const env = yield* hasura.envFor(n)
        const b64 = Buffer.from(env, "utf8").toString("base64")
        yield* machines.runInRepo(machineFor(n), `echo ${b64} | base64 -d > apps/backend/.env`)
      })

    return {
      list,

      /** Clone base -> next free number, start it, provision its stack. */
      create: Effect.gen(function* () {
        const agents = yield* list
        const used = new Set(agents.map((a) => a.n))
        let n = 1
        while (used.has(n)) n++
        const machine = machineFor(n)
        yield* machines.clone(BASE_MACHINE, machine)
        yield* machines.start(machine)
        yield* provision(n)
        return { n, name: machine }
      }),

      /** Start the whole agent: VM + stack containers + fresh .env.
       * Preserved /agent_n pg data (if any) is reused. */
      start: (n: number) =>
        requireAgent(n).pipe(
          Effect.zipRight(machines.start(machineFor(n))),
          Effect.zipRight(provision(n)),
        ),

      /** Stop the whole agent: codex + VM + stack containers.
       * The pg data dir is kept, so start() resumes with the same data. */
      stop: (n: number) =>
        requireAgent(n).pipe(
          Effect.tap(() => Effect.sync(() => Codex.killSession(machineFor(n)))),
          Effect.zipRight(machines.stop(machineFor(n))),
          Effect.zipRight(hasura.halt(n)),
        ),

      remove: (n: number) =>
        requireAgent(n).pipe(
          Effect.tap(() => Effect.sync(() => Codex.killSession(machineFor(n)))),
          Effect.zipRight(machines.stop(machineFor(n)).pipe(Effect.ignore)),
          Effect.zipRight(machines.delete(machineFor(n))),
          Effect.zipRight(hasura.down(n)),
        ),

      stopCodex: (n: number) => Effect.sync(() => Codex.killSession(machineFor(n))),

      /** Repair: re-provision the stack of a running agent (containers crashed,
       * env template changed, ...). Not part of the normal lifecycle. */
      stackUp: (n: number) => requireAgent(n).pipe(Effect.zipRight(provision(n))),

      doctor: (n: number) =>
        requireAgent(n).pipe(
          Effect.zipRight(
            machines.runInRepo(
              machineFor(n),
              `
              echo "node:  $(node --version)"
              echo "pnpm:  $(pnpm --version)"
              echo "codex: $(codex --version)"
              echo "gh:    $(gh api user --jq .login 2>/dev/null || echo NOT-AUTHED)"
              echo "repo:  $(git branch --show-current)"
              echo "--- agent stack (host) ---"
              for p in ${pgPort(n)}:pg ${redisPort(n)}:redis ${hasuraPort(n)}:hasura 7233:temporal; do
                port=\${p%%:*}; name=\${p##*:}
                (exec 3<>/dev/tcp/host.docker.internal/$port) 2>/dev/null && echo "$name :$port OK" || echo "$name :$port FAIL"
              done
              echo "--- backend (in VM, started by codex when needed) ---"
              (exec 3<>/dev/tcp/127.0.0.1/8010) 2>/dev/null && echo "backend :8010 UP" || echo "backend :8010 down (ok)"
              `,
            ),
          ),
        ),
    }
  }),
}) {}
