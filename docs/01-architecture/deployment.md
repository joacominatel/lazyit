---
title: Deployment
tags: [architecture]
status: accepted
created: 2026-05-25
updated: 2026-06-23
---

# Deployment

lazyit ships as containers run on a **single host with Docker Compose** — the right size for a
self-hosted, single-org tool ([[0015-deployment-model]]). The implementation lives in `infra/`
(see its README); this note is the architecture overview. Decisions:
[[0025-containerization-strategy]] · [[0026-reverse-proxy-tls]] · [[0027-ci-pipeline]] ·
[[0028-secrets-and-config]].

## Constraints (from [[vision]] and [[0015-deployment-model]])

- **Self-hosted, single-org.** Runs inside the company; not multi-tenant SaaS.
- **Operable by a small team.** Minimal moving parts; boring, durable infrastructure — single
  Compose host, not Kubernetes/Nomad.

## Topology

```
                          ┌─────────── host ───────────┐
  browser ──HTTPS:443──▶  │  Caddy  (TLS, reverse proxy)│
                          │    │ /            ─▶ web :3000 (Next.js standalone, Node)
                          │    │ /api/*       ─▶ api :3001 (NestJS, Node)  [prefix stripped]
                          │    │ /api/docs*   ─▶ NOT proxied in prod (SEC-009; internal/dev only)
                          │   api ──▶ db :5432 (Postgres 18)               │
                          │   api ──▶ meilisearch :7700 (search, no published port)
                          │   api ──▶ valkey :6379 (BullMQ broker, AOF)    │
                          │   migrate (one-shot: prisma migrate deploy + seed)
                          │   internal network — only Caddy publishes ports │
                          └────────────────────────────┘
```

- **Components:** Postgres, a one-shot **migrate** job, the **API**, the **web** app, **Caddy**,
  **Meilisearch** (the full-text search engine — [[stack]], [[0035-search-architecture]]), and
  **Valkey** (the BullMQ broker for the async `.docx` import + the Applications Workflow Engine —
  [[stack]]). With the bundled IdP, a **Zitadel** server + DB + one-shot bootstrap sidecar also run
  ([[auth-zitadel-sot]]).
- **Images:** multi-stage, built with Bun, run on Node (`node:26-alpine`); the API runs
  `node dist/src/main`, the web runs the Next.js standalone server. The migrate job runs on Bun
  (the seed needs it). Details: [[0025-containerization-strategy]].
- **Reverse proxy / TLS:** **Caddy** with automatic HTTPS — internal CA for local prod-like,
  Let's Encrypt for a real domain. **Same-origin routing**: the browser calls `/api/*` and Caddy
  forwards it to the API, so the web image is domain-portable (`NEXT_PUBLIC_API_URL=/api`, baked at
  build). Details: [[0026-reverse-proxy-tls]].
- **Migrations in prod:** the `migrate` job runs `prisma migrate deploy` (never `migrate dev`/
  `reset`) then the idempotent seed, before the API starts. → [[prisma-migrations]].
- **Async substrate (Valkey):** a **Valkey** container (`valkey:8-alpine`, the Redis-compatible BSD
  fork) is the **BullMQ broker** for background jobs — the async `.docx` import and the Applications
  Workflow Engine ([[stack]], [[0053-async-workers-bullmq-valkey]]). It runs with **AOF persistence**
  (`--appendonly yes --appendfsync everysec`) to a **named volume** (`valkey_data`) so queued jobs
  survive a restart, a `valkey-cli ping` **healthcheck**, and a memory/CPU ceiling; the API gains
  **`depends_on: valkey { condition: service_healthy }`**. Like the DBs it stays **internal-network
  only and never publishes its port in prod** (the dev override binds `127.0.0.1:6379`).
- **Search (Meilisearch):** a **Meilisearch** container (`getmeili/meilisearch:v1.12.3`) serves
  full-text search for articles and assets ([[stack]], [[0035-search-architecture]]). Like the DBs it
  stays **internal-network only and never publishes a port in prod** (the dev override binds
  `127.0.0.1:7700`). The integration is **fail-soft**: the API **no-ops** when Meili is down, so an
  outage degrades search but never takes down the app. Its index is a **rebuildable projection** of
  Postgres, so the `meili_data` **volume need not be backed up** — it is reconstructed with
  `reindex:all` ([[backups]], [[0035-search-architecture]]). A **one-off `reindex:all` is required
  after the first deploy** (and after any volume rebuild) or search returns no hits.
- **Secrets/config:** one `.env` per scope with a committed `.env.example`; the prod
  `infra/env/.env.prod` is gitignored, with `CHANGE_ME` placeholders and host-side protection. No
  Docker secrets block or external manager (YAGNI). New scoped env: **`REDIS_URL`** (the Valkey URL,
  e.g. `redis://valkey:6379`) and **`WORKFLOW_SECRET_KEY`** (the AES-256-GCM key for the workflow
  secret store — 32 bytes / 64 hex via `openssl rand -hex 32`, fail-loud at boot if missing).
  → [[0028-secrets-and-config]].
- **Exposure:** only Caddy publishes ports; Postgres, Meilisearch, Valkey, the API and web stay on the
  internal network. The dev DB, Meilisearch and Valkey bind loopback only.
  → [[0028-secrets-and-config]], SEC-005.
- **Backups:** manual `pg_dump`/`pg_restore` now, automation deferred. **`WORKFLOW_SECRET_KEY` is a
  third unrotatable DR linchpin** (alongside `POSTGRES_PASSWORD` and `ZITADEL_MASTERKEY`): losing it
  makes every stored connector credential undecryptable, so back it up off-host with the *matching*
  DB dump. → [[backups]].

## Deployment levels

| Level | What runs | Runbook |
| --- | --- | --- |
| **Dev** | root `compose.yaml` + auto-loaded `compose.override.yaml` (backing services) + `bun run dev` | [[setup]] |
| **Local prod-like** | `compose.yaml` + `infra/docker-compose.prod.yaml` + `--profile prod`, local HTTPS, high ports 8080/8443 | [[docker-prod-like-first-boot]] |
| **Self-hosted real** | same compose, real domain + Let's Encrypt, real secrets, backups | [[deploy-self-hosted]] |

## First deploy — the guided bootstrap (`infra/start.sh`)

The **recommended** first-deploy path is the guided, idempotent, **non-destructive** `infra/start.sh`
([[0047-guided-first-deploy-bootstrap]]) — a thin POSIX-`sh` wrapper over the existing env contract +
prod compose (it adds no app logic and changes no contract). Shape **DETECT → ASK → GENERATE → UP →
POINT**: it checks prerequisites, asks ~6 questions, renders `infra/env/.env.prod` with strong random
secrets (eliminating the three classic foot-guns — the exactly-32-char `ZITADEL_MASTERKEY`, the
`DATABASE_URL`/`POSTGRES_PASSWORD` coupling, and the forgotten `chmod 600`), runs the canonical prod
compose, and points the operator at **`https://<host>/setup`**. It **never** regenerates the unrotatable
`MASTERKEY` or runs any teardown — a destructive reset stays a documented manual operation. The manual
`cp`/`openssl`/`chmod`/`up` steps remain documented as the explicit fallback ([[deploy-self-hosted]],
[[docker-prod-like-first-boot]]).

## CI/CD

CI (GitHub Actions) gates every PR/push: typecheck, lint, test, build, and a Docker image build
(not published). The image builds run **in parallel** (a matrix over `api`/`web`/`migrate`) and
**concurrently with** the verify gate, so the Docker stage is no longer the wall-clock long pole
([[0052-ci-parallel-docker-and-decoupled-verify]]). **CD is deferred** — there's no deploy target
yet; the registry will be GHCR when one exists. → [[0027-ci-pipeline]].

## Identity & authorization (as built)

Auth is **live**, not reserved: the IdP is **Zitadel** with a **BYOI** (bring-your-own-OIDC) escape
hatch ([[0037-idp-choice-zitadel-byoi]], [[0043-zitadel-source-of-truth]]). In the bundled flow a
one-shot **`zitadel-bootstrap` sidecar** (prod profile) provisions the project / OIDC app / roles / a
runtime service-account key zero-touch and writes `oidc-client.json` to the `zitadel_secrets` volume,
which `api`/`web` read at startup; Caddy reverse-proxies `auth.<domain>` → `zitadel:8080`. The first
ADMIN is created by the in-app **`/setup` wizard** (the bootstrap script never creates a user). The IdP
`sub` maps to `User.externalId` (JIT on first login — [[0038-jit-user-provisioning]]). Full topology +
gotchas: [[auth-zitadel-sot]].

**Authorization** is DB-first fine-grained permissions (`@RequirePermission`) for two principal kinds —
humans and non-human [[service-account]]s — entirely **lazyit-local** (permissions never touch the IdP,
so they ride BYOI unchanged). Service accounts authenticate with a lazyit-native token, no IdP on their
path. See [[authorization]], [[0046-roles-permissions-v2]], [[0048-service-accounts]].

## Open questions

- **CD pipeline** — registry (GHCR) + deploy flow + image tagging, once a target exists.
- **Backup automation** — scheduled + offsite, when there's a real deployment ([[backups]]).
- **Dedicated worker container** — the async worker is co-located in the `api` container for now;
  splitting it out is a documented follow-up when job volume / CPU-heavy flows warrant it
  ([[0053-async-workers-bullmq-valkey]]).

Related: [[stack]] · [[monorepo]] · [[setup]] · [[authorization]] · [[auth-zitadel-sot]] ·
[[backups]] · [[05-runbooks/_MOC|Runbooks]] · [[0025-containerization-strategy]] ·
[[0026-reverse-proxy-tls]] · [[0027-ci-pipeline]] · [[0028-secrets-and-config]] ·
[[0035-search-architecture]] · [[0043-zitadel-source-of-truth]] ·
[[0047-guided-first-deploy-bootstrap]] · [[0053-async-workers-bullmq-valkey]] ·
[[0054-applications-workflow-engine]]
