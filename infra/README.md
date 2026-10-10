# infra/ — deployment & operations

Everything needed to run lazyit as containers lives here. lazyit is **self-hosted, single-org**
(ADR-0015): one instance = one organization, run on a single host with Docker Compose. This is the
DevOps lane (skill: `.claude/skills/lazyit-devops/SKILL.md`); the source of truth is `docs/`.

## Layout

The canonical Compose definition is a single **`compose.yaml` at the repo root** (all services;
prod-only ones gated behind `profiles: [prod]`), with a committed root `compose.override.yaml` for
dev tuning. This folder keeps only the **thin prod override**.

```
(repo root)
├── compose.yaml             # canonical: ALL services; db/meilisearch/valkey unprofiled (dev backing),
│                            # api/web/migrate/caddy/backup behind profiles: [prod]
├── compose.override.yaml    # dev tuning of the backing services (loopback ports, no limits)
infra/
├── start.sh                 # guided, idempotent, non-destructive first-deploy bootstrap — ADR-0047
├── update.sh                # guided, non-destructive in-place version update            — ADR-0084
├── trust-local-ca.sh        # trust Caddy's local internal-CA root on this machine (local mode only)
├── docker-compose.prod.yaml # THIN prod override: prod env-file path, `lazyit-prod` project name
├── docker/
│   ├── api.Dockerfile       # NestJS on Node, built with Bun (multi-stage)               — ADR-0025
│   ├── web.Dockerfile       # Next.js standalone on Node, built with Bun                 — ADR-0025
│   └── migrate.Dockerfile   # one-shot Bun job: `prisma migrate deploy` + seed           — ADR-0025
├── caddy/
│   └── Caddyfile            # reverse proxy + automatic HTTPS, same-origin /api          — ADR-0026
├── env/
│   └── .env.prod.example    # template for the (gitignored) .env.prod                    — ADR-0028
└── test/                    # shell tests for the scripts and the Caddy routing
```

## Scripts

| Script | What it does | Run | Ref |
| --- | --- | --- | --- |
| `start.sh` | **Guided first-deploy bootstrap.** Detects the environment, asks ~6 questions (free-text answers validated), generates `env/.env.prod` (real `openssl` secrets, **mode 600 from creation**, atomic write) and brings the prod stack up — then points you at `/setup`. Idempotent + non-destructive (skips generation on an existing install; never regenerates `WORKFLOW_SECRET_KEY`; no teardown path). | `./infra/start.sh` (`--yes` / `--dry-run` / `--help`) | ADR-0047 |
| `update.sh` | **Guided in-place update** to a release tag: verified database dump first, then checkout, build, migrate, health gate, rollback on failure. | `./infra/update.sh` (`--help`) | ADR-0084 |

## Deployment levels

| Level | How | Notes |
| --- | --- | --- |
| **Dev** | root `docker compose up` (db + meilisearch + valkey) + `bun run dev` | backing services in containers, apps run natively. Auto-merges `compose.override.yaml`. |
| **Local prod-like** | root `compose.yaml` + thin override + `--profile prod` | full stack in containers, HTTPS via Caddy's internal CA, high ports (8080/8443). |
| **Self-hosted real** | same command + real domain | Let's Encrypt, real secrets, backups. See runbooks. |

## Quick start (local prod-like)

Recommended — the guided bootstrap (ADR-0047) generates `env/.env.prod` with real secrets,
`chmod 600`s it, brings the stack up, and points you at `/setup`:

```sh
./infra/start.sh            # guided; accept the defaults for a localhost prod-like smoke test
# open https://localhost:8443/setup  (Caddy's internal CA → accept/trust the local cert)
```

Manual fallback — do exactly what the script automates, by hand:

```sh
cp infra/env/.env.prod.example infra/env/.env.prod   # then edit: replace every CHANGE_ME
chmod 600 infra/env/.env.prod
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build
# open https://localhost:8443  (Caddy's internal CA → accept/trust the local cert)
```

> [!note] Backward-compat
> The old `docker compose -f infra/docker-compose.prod.yml up -d --build` is superseded; it maps 1:1
> to the base + thin override + `--profile prod` + `--env-file` command above. The prod project name
> stays `lazyit-prod`, so existing volumes are reused. Plain `docker compose up` (no `-f`) is now the
> **dev backing-services** stack, not the full prod stack.

Full walkthrough: `docs/05-runbooks/docker-prod-like-first-boot.md`.
Real deployment: `docs/05-runbooks/deploy-self-hosted.md`.
Build problems: `docs/05-runbooks/docker-build-troubleshooting.md`.
Backups: `docs/05-runbooks/backups.md`.

## Key design points

- **Build with Bun, run on Node.** The app runtime is Node (`node dist/main`), not Bun — ADR-0009.
  Images are multi-stage: `oven/bun` builder → `node:26-alpine` runtime.
- **Migrations are a one-shot job.** `migrate` runs `prisma migrate deploy` + seed after Postgres is
  healthy and before the API starts. The seed needs Bun (`bun prisma/seed.ts`).
- **Same-origin routing.** Caddy serves the web at `/` and forwards `/api/*` to the API (stripping
  the prefix). `/api/docs*` (Swagger) is **not** forwarded on the public origin — it falls through
  the `/api` strip to `/docs*`, which the API doesn't serve, so a public `/api/docs` returns **404**
  (SEC-009); the docs stay reachable on the internal Docker network and in local dev. The web image
  bakes `NEXT_PUBLIC_API_URL=/api`, so one image works on any domain — ADR-0026. A short allowlist of
  **unprefixed** paths for external AI agents — `/mcp`, `/.well-known/oauth-protected-resource*`,
  `/.well-known/oauth-authorization-server*`, `/oauth/{token,register,revoke}` — also reaches the API,
  unstripped (ADR-0097); the API answers 404 there until MCP is enabled. So do the paths MCP clients
  probe when that metadata is missing — `/.well-known/openid-configuration*`, `/authorize`, `/token`,
  `/register` — which the API never serves: a JSON 404 rather than the web app's `/login` HTML (#1315).
- **Streams skip compression.** `encode` wraps every response except streamed ones (the AI run event
  stream, `/mcp`, any `Accept: text/event-stream` request): the pinned Caddy withholds and compresses
  SSE otherwise. `test/caddy-routing.sh` asserts the routing and runs a live SSE probe (ADR-0097).
- **Least exposure.** Only Caddy publishes ports. Postgres/API/Web are on the internal network;
  Postgres is never reachable from the host — ADR-0028 / SEC-005.
- **Secrets** live in the gitignored `env/.env.prod` (copied from the example). Never committed,
  never trivial — ADR-0028. `chmod 600` it: it holds the DB password, `WORKFLOW_SECRET_KEY`,
  `AUTH_SECRET`, and, with OIDC, the client secret.
- **Auth** is local accounts by default (`AUTH_MODE=local`, ADR-0086) or your own OIDC IdP
  (`AUTH_MODE=oidc`, bring-your-own): set the `OIDC_*` values for the API and the `AUTH_*` values for
  the web in `.env.prod`. No IdP ships with lazyit — the bundled Zitadel was removed (ADR-0102).
- **Image digest-pinning** (ADR-0025 follow-up): every base image is pinned by `@sha256` with the
  human tag in a comment, so deploys are reproducible and rolling tags can't drift silently. Re-pin
  after a deliberate bump (command at the bottom of `compose.yaml`).
- **Disk/OOM safety**: every long-running compose service has a `logging:` rotation block
  (json-file, 10m x 3) and a modest `mem_limit`/`cpus` so logs can't fill the disk and one runaway
  service can't OOM the single host.
- **Backups**: an opt-in `backup` profile sidecar runs cron + `pg_dump` of the app database to a
  host-mounted `./backups` with retention on `app-*.dump` (off by default). Full DR procedure (what to back up,
  restore order): `docs/05-runbooks/backups.md`.

## Not configured yet (reserved)

- **CD / image publishing** (ADR-0027): CI builds the images but does not push. Registry will be
  GHCR when a deploy target exists.
