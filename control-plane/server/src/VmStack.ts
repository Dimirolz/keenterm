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

const startBackendSchemaMock = [
  "test -f apps/backend/src/@modules/graphql/schema.gql",
  `(
    pnpm --filter @shilo/graphql-api exec tsx -e '
      import http from "node:http";
      import { readFileSync } from "node:fs";
      import { buildSchema, graphql } from "graphql";

      const schema = buildSchema(readFileSync("../../apps/backend/src/@modules/graphql/schema.gql", "utf8"));
      const server = http.createServer(async (req, res) => {
        if (req.method !== "POST") {
          res.end("OK");
          return;
        }

        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const result = await graphql({
          schema,
          source: body.query,
          variableValues: body.variables,
          operationName: body.operationName,
        });

        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
        setTimeout(() => server.close(() => process.exit(0)), 250);
      });

      server.listen(8010, "0.0.0.0");
      setTimeout(() => process.exit(2), 120000);
    ' >/tmp/orb-backend-schema-mock.log 2>&1 &
    echo $! >/tmp/orb-backend-schema-mock.pid
  )`,
].join(" && ")

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
            `${startBackendSchemaMock} || true`,
            "sleep 1",
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
