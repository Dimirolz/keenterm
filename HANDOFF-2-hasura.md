# Orb Agent Handoff 2 — Per-Agent Hasura

Continues from `HANDOFF.md` (Experiment 1 = clean base VM, repo + baked
`pnpm install`, fast clone verified).

## Why this matters for the PR loop (verified)

The minimal "Codex change -> PR" loop works WITHOUT infra, but the repo's
`.husky/pre-push` hook runs:

```sh
pnpm turbo run fetch-schema           # needs a live Hasura GraphQL endpoint
pnpm turbo run lint  --filter @shilo/web[...]
pnpm turbo run tsc:check --filter @shilo/web[...]
```

`fetch-schema` requires a running Hasura. So:

```text
push WITH hooks   -> needs per-agent Hasura (this experiment)
push --no-verify  -> works today (smoke-tested, PR #4037)
```

Other gotchas found during the smoke test:

```text
- asdf is only in ~/.bashrc; non-interactive/login shells (and husky
  hooks) don't get pnpm on PATH. Source ~/.asdf/asdf.sh, or add it to
  ~/.profile so git hooks can find pnpm.
- branch prefix `test/` collides with existing remote branch `test`
  ("directory file conflict"). Avoid `test/...` names.
- git identity + `gh auth setup-git` are now baked into the base.
```

## Goal

Give each agent VM its own Hasura GraphQL engine, wired to the backend
running **inside that same VM**.

Key directive:

```text
Per agent we ONLY run hasura/graphql-engine.
NOT postgres. NOT data-connector-agent.
```

Reasons:

- `postgres` → use shared host infra (`host.docker.internal:5432`).
- `data-connector-agent` → only needed for athena/mariadb/mysql/oracle/
  snowflake connectors. Not used. Skip it.
- `graphql-engine` → must be per-agent because it points at the backend
  (auth hook / actions / webhook) that lives inside the agent VM.

So instead of the full `hasura/docker-compose.yml`, run a single
graphql-engine container per agent.

## Starting State

```bash
orbctl list
```

```text
shilo-agent-base   stopped   frozen base (Node 22.22.0, pnpm 10.16.0, repo baked)
shilo-agent-1      stopped   verification clone
```

Repo inside VM:

```text
~/projects/shilo-ai-mono   (branch: dev)
```

Remember to load asdf in every non-login shell:

```bash
. ~/.asdf/asdf.sh
```

## What Hasura Needs (from repo)

`hasura/config.yaml`:

```yaml
version: 3
endpoint: http://localhost:8080
metadata_directory: metadata
admin_secret: ${HASURA_GRAPHQL_ADMIN_SECRET}
actions:
  kind: synchronous
  handler_webhook_baseurl: http://localhost:3000
```

graphql-engine env (from `hasura/docker-compose.yml` + `hasura/.env.example`):

```env
HASURA_GRAPHQL_METADATA_DATABASE_URL=<pg url>
PG_DATABASE_URL=<pg url>
HASURA_GRAPHQL_ADMIN_SECRET=<secret>
HASURA_GRAPHQL_CORS_DOMAIN=*
HASURA_GRAPHQL_EXPERIMENTAL_FEATURES=naming_convention
HASURA_GRAPHQL_JWT_SECRET=<jwt secret>          # if using JWT
HASURA_GRAPHQL_UNAUTHORIZED_ROLE=anonymous
HASURA_GRAPHQL_AUTH_HOOK=<backend auth hook url>
API_URL=<backend api url>
WEBHOOK_URL=<backend webhook url>
HASURA_GRAPHQL_ENABLE_CONSOLE=false
HASURA_GRAPHQL_DEV_MODE=true
```

Image used in repo:

```text
hasura/graphql-engine:v2.40.0
```

## Backend Ports (from apps/backend/.env.example)

```env
BASE_URL=http://localhost:8010    # backend HTTP
APP_URL=http://localhost:3001
# hasura actions handler baseurl in config = http://localhost:3000
```

Backend also reads (apps/backend/.env.example):

```env
HASURA_URL=""                     # backend -> hasura
HASURA_GRAPHQL_ADMIN_SECRET=""
WEBHOOK_URL=""
```

So the wiring is bidirectional:

```diagram
╭──────────────── agent VM (shilo-agent-N) ─────────────────╮
│                                                            │
│  backend (8010 / 3000)  ◀── auth hook / actions ──┐        │
│        │  HASURA_URL                               │        │
│        ▼                                           │        │
│  graphql-engine :8080  ─────────────────────────--┘        │
│        │ PG_DATABASE_URL                                    │
╰────────┼───────────────────────────────────────────────---╯
         ▼
   host.docker.internal:5432   (shared Postgres on host)
```

## Hasura CLI Scripts (already in repo)

From `hasura/package.json` (package `@shilo/hasura`):

```json
"hasura:metadata": "hasura metadata apply && hasura metadata reload",
"db:migrate":      "hasura migrate apply --all-databases && pnpm run hasura:metadata"
```

Root `package.json`:

```text
pnpm migrate          -> turbo run db:migrate
pnpm metadata:apply   -> pnpm --filter @shilo/hasura hasura:metadata
pnpm h:console        -> hasura console --project ./hasura
```

Note: `hasura` CLI is NOT yet installed in the base VM. Will need to add it
(or run via npx) for migrate / metadata apply.

## Open Decisions (resolve before building)

1. How to run graphql-engine per agent:
   - (a) `docker run` INSIDE each VM (needs docker installed in VM; full
     isolation; container reaches backend via VM localhost / 172.17.0.1).
   - (b) container on HOST OrbStack docker, one per agent, AUTH_HOOK ->
     `shilo-agent-N.orb.local:<port>` (no docker in VM, but less isolated).
   Lean (a) for isolation consistency with the rest of the design.

2. Postgres strategy:
   - Shared host Postgres (`host.docker.internal:5432`) is simplest, but
     multiple agents would share DB state -> breaks isolation.
   - Per-agent DB (separate database/schema on shared PG, or a PG per VM)
     keeps isolation. Decide based on how much state the backend mutates.

3. `HASURA_GRAPHQL_JWT_SECRET` vs `HASURA_GRAPHQL_AUTH_HOOK`: confirm which
   auth mode the backend expects locally.

4. Port exposure: backend already plans `http://shilo-agent-N.orb.local:8010`.
   Decide the public hasura port (e.g. `:8080` ->
   `http://shilo-agent-N.orb.local:8080`).

5. Where to get real env values (admin secret, jwt secret, API keys). Check
   staging / 1Password; `hasura/db:sync` pulls from staging.

## Rough Plan

1. Install docker inside base VM (if going with option a). Re-freeze base.
2. Install hasura CLI in base (or use npx). Re-freeze base.
3. On an agent clone:
   - start backend (`pnpm b:dev`) inside VM.
   - run graphql-engine container with env above, PG -> host or per-agent.
   - `pnpm migrate` (migrate + metadata apply) against the agent's hasura.
4. Verify:
   - `http://shilo-agent-1.orb.local:8080/healthz`
   - GraphQL query through hasura hits backend auth hook successfully.
   - backend `HASURA_URL` round-trips.

## Open Questions Carried Over

- Per-agent vs shared Postgres (see decision 2).
- Whether to bake docker + hasura CLI + a pulled graphql-engine image into
  the base so clones stay fast.
- Disk growth per agent once Hasura + backend are running.
