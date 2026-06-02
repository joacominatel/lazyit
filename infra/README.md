# infra/ — deployment & operations

Everything needed to run lazyit as containers lives here. lazyit is **self-hosted, single-org**
(ADR-0015): one instance = one organization, run on a single host with Docker Compose. This is the
DevOps lane (skill: `.claude/skills/lazyit-devops/SKILL.md`); the source of truth is `docs/`.

## Layout

The canonical Compose definition is a single **`compose.yaml` at the repo root** (all services;
prod-only ones gated behind `profiles: [prod]`), with a committed root `compose.override.yaml` for
dev tuning. This folder keeps only the **thin prod override**. See
[[auth-zitadel-sot#9-compose-structure-decided|dossier §9]].

```
(repo root)
├── compose.yaml             # canonical: ALL services; db/meili/zitadel(+db) unprofiled (dev backing),
│                            # api/web/migrate/caddy/backup/zitadel-bootstrap behind profiles: [prod]
├── compose.override.yaml    # dev tuning of the backing services (loopback ports, no TLS, no limits)
infra/
├── start.sh                 # guided, idempotent, non-destructive first-deploy bootstrap   — ADR-0047
├── docker-compose.prod.yaml # THIN prod override: env-file path, internal-only net, zitadel_secrets vol
├── docker/
│   ├── api.Dockerfile               # NestJS on Node, built with Bun (multi-stage)        — ADR-0025
│   ├── web.Dockerfile               # Next.js standalone on Node, built with Bun          — ADR-0025
│   ├── migrate.Dockerfile           # one-shot Bun job: `prisma migrate deploy` + seed    — ADR-0025
│   └── zitadel-bootstrap.Dockerfile # tiny alpine (curl+jq+openssl): zero-touch IdP setup — ADR-0043
├── scripts/
│   └── zitadel-bootstrap.sh  # one-shot, fail-loud, idempotent Zitadel provisioner        — ADR-0043
├── caddy/
│   └── Caddyfile             # reverse proxy + automatic HTTPS, same-origin /api    — ADR-0026
└── env/
    └── .env.prod.example     # template for the (gitignored) .env.prod             — ADR-0028
```

## Scripts

| Script | What it does | Run | Ref |
| --- | --- | --- | --- |
| `start.sh` | **Guided first-deploy bootstrap.** Detects the environment, asks ~6 questions, generates `env/.env.prod` (real `openssl` secrets, `chmod 600`, atomic write) and brings the prod stack up — then points you at `/setup`. Idempotent + non-destructive (skips generation on an existing install; never regenerates `ZITADEL_MASTERKEY`; no teardown path). | `./infra/start.sh` (`--yes` / `--dry-run` / `--help`) | ADR-0047 |
| `scripts/zitadel-bootstrap.sh` | One-shot, fail-loud, idempotent Zitadel provisioner (the `zitadel-bootstrap` sidecar's entrypoint). Wires the OIDC project/app/roles/SA — **no console clicking**. Not run by hand. | runs as the sidecar under `--profile prod` | ADR-0043 |

## Deployment levels

| Level | How | Notes |
| --- | --- | --- |
| **Dev** | root `docker compose up` (db + meili + zitadel(+db)) + `bun run dev` | backing services in containers, apps run natively. Auto-merges `compose.override.yaml`. |
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
  the prefix; `/api/docs*` is passed through for Swagger). The web image bakes
  `NEXT_PUBLIC_API_URL=/api`, so one image works on any domain — ADR-0026.
- **Least exposure.** Only Caddy publishes ports. Postgres/API/Web are on the internal network;
  Postgres is never reachable from the host — ADR-0028 / SEC-005.
- **Secrets** live in the gitignored `env/.env.prod` (copied from the example). Never committed,
  never trivial — ADR-0028. `chmod 600` it: it holds the DB password, `ZITADEL_MASTERKEY`,
  `AUTH_SECRET`, and the OIDC secret.
- **Auth is wired** (ADR-0037/0038/0039): a bundled Zitadel IdP (its own `zitadel_db`) served at
  `auth.{LAZYIT_DOMAIN}` via Caddy; the API validates OIDC tokens, the web app uses Auth.js.
- **Zero-touch IdP bootstrap** (ADR-0043 Phase 3): the one-shot `zitadel-bootstrap` sidecar (prod
  profile) provisions the project, OIDC app, the `ADMIN`/`MEMBER`/`VIEWER` project roles and a
  runtime service-account from the FirstInstance machine key — **no console clicking** — and writes
  `oidc-client.json` + `sa-key.json` into the shared `zitadel_secrets` volume that api/web read.
  Fail-loud (`restart: "no"`) + idempotent. Bootstrap: `docs/05-runbooks/auth-bootstrap.md` §0.
  BYOI by changing the `OIDC_*` vars and dropping the zitadel services.
- **Image digest-pinning** (ADR-0025 follow-up): every base image is pinned by `@sha256` with the
  human tag in a comment, so deploys are reproducible and rolling tags can't drift silently. Re-pin
  after a deliberate bump (command at the bottom of `compose.yaml`).
- **Disk/OOM safety**: every long-running compose service has a `logging:` rotation block
  (json-file, 10m x 3) and a modest `mem_limit`/`cpus` so logs can't fill the disk and one runaway
  service can't OOM the single host.
- **Backups**: an opt-in `backup` profile sidecar runs cron + `pg_dump` for **both** databases to a
  host-mounted `./backups` with retention (off by default). Full DR procedure (what to back up,
  restore order): `docs/05-runbooks/backups.md`.

## Not configured yet (reserved)

- **CD / image publishing** (ADR-0027): CI builds the images but does not push. Registry will be
  GHCR when a deploy target exists.
