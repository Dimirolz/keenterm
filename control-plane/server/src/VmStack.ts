import { Effect } from "effect"
import { BACKEND_DEP_SERVICES, HASURA_SERVICES, machineFor } from "./config.js"
import { Machines } from "./Machines.js"

export interface StackStatus {
  readonly pg: boolean
  readonly redis: boolean
  readonly hasura: boolean
}

export const stackUp = (s: StackStatus) => s.pg && s.redis && s.hasura

const NO_STACK: StackStatus = { pg: false, redis: false, hasura: false }

const detect = (out: string): StackStatus => {
  const text = out.toLowerCase()
  return {
    pg: text.includes("postgres"),
    redis: text.includes("redis"),
    hasura: text.includes("hasura") || text.includes("graphql-engine"),
  }
}

export class VmStack extends Effect.Service<VmStack>()("VmStack", {
  dependencies: [Machines.Default],
  effect: Effect.gen(function* () {
    const machines = yield* Machines

    const status = (n: number) =>
      machines
        .runInRepo(machineFor(n), `docker ps --format '{{.Names}} {{.Image}}'`)
        .pipe(Effect.map(detect), Effect.catchAll(() => Effect.succeed(NO_STACK)))

    const up = (n: number) =>
      machines.runInRepo(
        machineFor(n),
        (() => {
          const hasuraAppServices = HASURA_SERVICES.filter((s) => s !== "postgres")
          return [
            "cd hasura",
            "docker compose up -d postgres",
            hasuraAppServices.length ? `docker compose up -d --no-deps ${hasuraAppServices.join(" ")}` : ":",
            "docker update --memory 512m --memory-swap 512m shilo-graphql-engine-1 >/dev/null 2>&1 || true",
            `cd ../apps/backend && docker compose up -d ${BACKEND_DEP_SERVICES.join(" ")}`,
          ].join(" && ")
        })(),
      )

    return { up, status }
  }),
}) {}
