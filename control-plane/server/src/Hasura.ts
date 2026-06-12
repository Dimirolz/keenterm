// Per-agent app stack on the host: orb-pg-N + orb-redis-N + orb-hasura-N.
// All commands were validated as plain shell in exp4 (HANDOFF-4).
//
// The backend process inside the VM is deliberately NOT managed here: the
// agent (codex) starts it itself (`pnpm backend:web`) when it needs a live
// stack. The control plane only provides what codex cannot create from
// inside the VM — host containers and the per-agent .env.

import { FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Data, Effect } from "effect"
import {
  GOLDEN_VOLUME,
  HOST_BACKEND_ENV,
  hasuraPort,
  MAIN_PG_CONTAINER,
  MAIN_PG_VOLUME,
  machineFor,
  pgPort,
  redisPort,
} from "./config.js"
import { Sh } from "./Sh.js"

export class HostEnvMissing extends Data.TaggedError("HostEnvMissing")<{
  readonly path: string
}> {}

export interface StackStatus {
  readonly pg: boolean
  readonly redis: boolean
  readonly hasura: boolean
}

export const stackUp = (s: StackStatus) => s.pg && s.redis && s.hasura

const PG_PASSWORD = "postgrespassword"
const CONTAINER_RE = /^orb-(pg|redis|hasura)-(\d+)$/

/** .env keys the control plane owns for an agent (everything else is copied
 * verbatim from the host backend .env). WRITE_DB/READONLY_DB point at the
 * agent's own pg — never at Neon prod. */
const envOverrides = (n: number): Record<string, string> => {
  const db = {
    HOST: "host.docker.internal",
    PORT: String(pgPort(n)),
    NAME: "postgres",
    USER: "postgres",
    PASSWORD: PG_PASSWORD,
  }
  return {
    HASURA_URL: `http://host.docker.internal:${hasuraPort(n)}`,
    UPSTASH_REDIS_URL: `redis://host.docker.internal:${redisPort(n)}`,
    UPSTASH_REDIS_CACHE_URL: `redis://host.docker.internal:${redisPort(n)}`,
    TEMPORAL_WORKER_ENABLED: "false",
    ...Object.fromEntries(
      Object.entries(db).flatMap(([k, v]) => [
        [`WRITE_DB_${k}`, v],
        [`READONLY_DB_${k}`, v],
      ]),
    ),
  }
}

/** Per-agent pg/redis/hasura containers + golden CoW lifecycle. */
export class Hasura extends Effect.Service<Hasura>()("Hasura", {
  dependencies: [Sh.Default, NodeContext.layer],
  effect: Effect.gen(function* () {
    const { run } = yield* Sh
    const fs = yield* FileSystem.FileSystem

    /** Run a script against the orb_pg volume (debian for reflink-capable cp). */
    const inVolume = (script: string) =>
      run("docker", "run", "--rm", "-v", `${GOLDEN_VOLUME}:/dst`, "debian:stable-slim", "bash", "-c", script)

    /** One-time golden snapshot: quiesce main pg, reflink its data dir.
     * Seconds of main downtime; main is always restarted, even on failure. */
    const ensureGolden = Effect.gen(function* () {
      yield* run("docker", "volume", "create", GOLDEN_VOLUME)
      const exists = yield* inVolume("test -d /dst/golden && echo yes || echo no")
      if (exists.trim() === "yes") return
      yield* Effect.log(`creating golden snapshot from ${MAIN_PG_CONTAINER} (brief main pg downtime)`)
      yield* run("docker", "stop", MAIN_PG_CONTAINER).pipe(
        Effect.zipRight(
          run(
            "docker", "run", "--rm",
            "-v", `${MAIN_PG_VOLUME}:/src:ro`,
            "-v", `${GOLDEN_VOLUME}:/dst`,
            "debian:stable-slim", "bash", "-c",
            "rm -rf /dst/golden.tmp && cp --reflink=always -a /src /dst/golden.tmp && mv /dst/golden.tmp /dst/golden",
          ),
        ),
        Effect.ensuring(run("docker", "start", MAIN_PG_CONTAINER).pipe(Effect.orDie)),
      )
    })

    const rm = (name: string) => run("docker", "rm", "-f", name).pipe(Effect.ignore)

    /** Provision (or re-provision) the agent's stack. Existing agent data dir
     * is kept; containers are recreated. ~1s when golden exists. */
    const up = (n: number) =>
      Effect.gen(function* () {
        yield* ensureGolden
        // CoW clone only if the agent has no data dir yet (keep its state otherwise)
        yield* inVolume(`test -d /dst/agent_${n} || cp --reflink=always -a /dst/golden /dst/agent_${n}`)
        yield* Effect.all([rm(`orb-pg-${n}`), rm(`orb-redis-${n}`), rm(`orb-hasura-${n}`)], { concurrency: 3 })

        yield* run(
          "docker", "run", "-d", "--name", `orb-pg-${n}`,
          "-v", `${GOLDEN_VOLUME}:/pgroot`,
          "-e", `PGDATA=/pgroot/agent_${n}`,
          "-e", `POSTGRES_PASSWORD=${PG_PASSWORD}`,
          "-p", `${pgPort(n)}:5432`,
          "postgres:15",
        )
        yield* run(
          "docker", "run", "-d", "--name", `orb-redis-${n}`, "--memory", "128m",
          "-p", `${redisPort(n)}:6379`,
          "redis:7-alpine", "redis-server", "--save", "", "--appendonly", "no",
        )
        const vm = `http://${machineFor(n)}.orb.local:8010`
        const pgUrl = `postgres://postgres:${PG_PASSWORD}@host.docker.internal:${pgPort(n)}/postgres`
        yield* run(
          "docker", "run", "-d", "--name", `orb-hasura-${n}`, "--memory", "512m",
          "-p", `${hasuraPort(n)}:8080`,
          "-e", `PG_DATABASE_URL=${pgUrl}`,
          "-e", `HASURA_GRAPHQL_METADATA_DATABASE_URL=${pgUrl}`,
          "-e", "HASURA_GRAPHQL_ADMIN_SECRET=hasura_graphql_admin_secret",
          "-e", "HASURA_GRAPHQL_CORS_DOMAIN=*",
          "-e", "HASURA_GRAPHQL_EXPERIMENTAL_FEATURES=naming_convention",
          "-e", "HASURA_GRAPHQL_ENABLE_CONSOLE=false",
          "-e", "HASURA_GRAPHQL_DEV_MODE=true",
          "-e", `HASURA_GRAPHQL_AUTH_HOOK=${vm}/auth/hasura`,
          "-e", `API_URL=${vm}`,
          "-e", `WEBHOOK_URL=${vm}`,
          "-e", `VENDOR_API_URL=${vm}/graphql`,
          "hasura/graphql-engine:v2.40.0",
        )
      })

    /** Remove the containers but KEEP the agent's pg data dir: the "stopped"
     * state of the stack. Containers are stateless, so a later up() recreates
     * them against the preserved data. Idempotent. */
    const halt = (n: number) =>
      Effect.all([rm(`orb-pg-${n}`), rm(`orb-redis-${n}`), rm(`orb-hasura-${n}`)], {
        concurrency: 3,
      }).pipe(Effect.asVoid)

    /** Full teardown: containers + the agent's CoW data dir. Idempotent. */
    const down = (n: number) =>
      Effect.gen(function* () {
        yield* halt(n)
        yield* inVolume(`rm -rf /dst/agent_${n}`).pipe(Effect.ignore) // volume may not exist yet
      })

    /** Live stack status per agent number, derived from `docker ps`. */
    const statusAll: Effect.Effect<Map<number, StackStatus>, never, never> = run(
      "docker", "ps", "--format", "{{.Names}}",
    ).pipe(
      Effect.map((out) => {
        const map = new Map<number, { pg: boolean; redis: boolean; hasura: boolean }>()
        for (const name of out.split("\n")) {
          const m = CONTAINER_RE.exec(name.trim())
          if (!m) continue
          const n = Number(m[2])
          const entry = map.get(n) ?? { pg: false, redis: false, hasura: false }
          entry[m[1] as "pg" | "redis" | "hasura"] = true
          map.set(n, entry)
        }
        return map as Map<number, StackStatus>
      }),
      Effect.orDie,
    )

    /** Agent .env content: host backend .env with orb overrides applied. */
    const envFor = (n: number) =>
      Effect.gen(function* () {
        const template = yield* fs
          .readFileString(HOST_BACKEND_ENV)
          .pipe(Effect.mapError(() => new HostEnvMissing({ path: HOST_BACKEND_ENV })))
        const overrides = envOverrides(n)
        const keys = new Set(Object.keys(overrides))
        const kept = template
          .split("\n")
          .filter((line) => {
            const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
            return !(m && keys.has(m[1]))
          })
          .join("\n")
        const block = Object.entries(overrides)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
        return `${kept.trimEnd()}\n\n# --- orb agent ${n} overrides (written by control plane; do not point at prod) ---\n${block}\n`
      })

    return { up, halt, down, statusAll, envFor }
  }),
}) {}
