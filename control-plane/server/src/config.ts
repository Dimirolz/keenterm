import * as os from "node:os"

export const PORT = Number(process.env.PORT ?? 7070)
export const PREFIX = "shilo-agent-"
export const BASE_MACHINE = "shilo-agent-base"
export const REPO_DIR = process.env.REPO_DIR ?? "~/projects/shilo-ai-mono"

export const machineFor = (n: number) => `${PREFIX}${n}`
export const MACHINE_RE = new RegExp(`^${PREFIX}(\\d+)$`)

// ---- per-agent app stack (pg + redis + hasura on the host) --------------------

/** Host port scheme: pg :154NN, redis :163NN, hasura :180NN. */
export const pgPort = (n: number) => 15400 + n
export const redisPort = (n: number) => 16300 + n
export const hasuraPort = (n: number) => 18000 + n

export const GOLDEN_VOLUME = "orb_pg" // /golden + /agent_N CoW data dirs
export const MAIN_PG_CONTAINER = "shilo-postgres-1" // live dev pg, source of golden
export const MAIN_PG_VOLUME = "shilo_shilo_db_data"

/** Host-side backend .env used as the template for each agent's .env. */
export const HOST_BACKEND_ENV =
  process.env.HOST_BACKEND_ENV ?? `${os.homedir()}/projects/shilo-ai-mono/apps/backend/.env`
