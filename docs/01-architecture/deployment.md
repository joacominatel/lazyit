---
title: Deployment
tags: [architecture]
status: accepted
created: 2026-05-25
updated: 2026-10-09
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
                          │    │ /api/auth/*  Auth.js actions → web :3000 (ADR-0039); API's
                          │    │              password endpoints → api :3001 (ADR-0086, #1250)
                          │    │ /api/docs*   ─▶ NOT proxied in prod (SEC-009; internal/dev only)
                          │    │ /mcp, /.well-known/oauth-*, /oauth/{token,register,revoke}
                          │    │              ─▶ api :3001 unstripped (AI agents, ADR-0097)
                          │    │ /.well-known/openid-configuration*, /authorize, /token,
                          │    │ /register    ─▶ api :3001 unstripped (JSON 404; #1315)
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
  [[stack]]). No identity provider ships in the stack: authentication is local accounts or your own
  OIDC IdP, running outside it ([[0102-remove-bundled-zitadel]]; see *Identity & authorization* below).
- **Images:** multi-stage, with dependencies installed and shared tooling run on Bun 1.4.2, and
  application runtimes on Node (`node:26-alpine`). The API compiles in its Bun builder and runs
  `node dist/src/main`; the web runs `next build` under a real Node 26 Debian build stage and serves
  the resulting standalone bundle on Node. The migrate job runs on Bun (the seed needs it). Details:
  [[0025-containerization-strategy]].
- **Reporting-agent binaries:** the API image bakes the Bun-compiled Linux collector (`apps/agent`,
  `x64` + `x64-baseline` + `arm64`) into `AGENT_BIN_DIR` (`/app/agent/bin`) via an extra build
  stage, and serves the right one over the token-gated `GET /api/agent/download`; the public
  `install.sh` (web `/public`) installs it as a systemd timer. `x64-baseline` is the pre-AVX2 build,
  picked automatically by the installer from `/proc/cpuinfo` — the ordinary `x64` target assumes
  AVX2 (Haswell, 2013) and SIGILLs on older or EVC-masked hosts. Each artifact ships a `.sha256`
  beside it, published by `GET /api/agent/checksum` and verified by the installer (an integrity
  check, not a signature). The agent embeds the Bun runtime, so it has a glibc/kernel floor on the
  target host; rather than hardcode a version, `install.sh` **runs the binary once** before it arms
  a timer and refuses if the host cannot start it. (Measured on Bun 1.3.14 and again on 1.4.2: the
  artifacts link no symbol newer than `GLIBC_2.17`.) Same-origin, version-locked, air-gapped-safe —
  no GitHub Release. → [[0074-server-reporting-agent]] §6.
- **Reverse proxy / TLS:** **Caddy**, with a **network/TLS mode chosen at install** (three, orthogonal
  to `AUTH_MODE` — [[0087-plain-http-lan-deployment-axis]]):
  - **`lan`** — `LAZYIT_SITE_ADDRESS=:80` (port-only) → Caddy serves **plain HTTP for any Host**, no TLS,
    no cert, no redirect (host-agnostic: survives a DHCP IP change). `AUTH_TRUST_HOST=true`, `WEB_ORIGIN`
    unset. **Requires `AUTH_MODE=local`.** Trusted-LAN only — the session is unencrypted in transit.
  - **`local`** — `localhost` + Caddy **internal-CA HTTPS** on high ports (browser warns until trusted).
  - **`real`** — a public FQDN + **Let's Encrypt** (or internal CA).
  **Same-origin routing** in every mode: the browser calls `/api/*` and Caddy forwards it to the API, so
  the web image is domain-portable (`NEXT_PUBLIC_API_URL=/api`, baked at build). The single
  `{$LAZYIT_SITE_ADDRESS}` site block already covers all three (a port-only value disables auto-TLS —
  verified with `caddy validate`); no per-mode Caddy block. Details: [[0026-reverse-proxy-tls]].
  - **External AI agents** ([[0097-ai-assistant-mcp-and-headless-api]]): a short allowlist of
    **unprefixed** paths also reaches the API, without the `/api` strip — `/mcp` (the MCP resource),
    `/.well-known/oauth-protected-resource*` and `/.well-known/oauth-authorization-server*` (RFC 9728 /
    RFC 8414 metadata) and `/oauth/token`, `/oauth/register`, `/oauth/revoke`. MCP clients and OAuth
    discovery address the bare origin, so these cannot live under `/api`. `/oauth/authorize` is the web
    consent page and stays on web. The API answers 404 on all of them while MCP is off; on a `lan`
    instance the OAuth rows stay 404 (OAuth needs HTTPS — `lan` uses personal tokens on `/mcp`).
    The same allowlist also sends the paths MCP SDK clients **probe** when the RFC 8414 metadata is
    missing — OIDC discovery (`/.well-known/openid-configuration*`) and the root fallbacks `/authorize`,
    `/token`, `/register` — to the API, which serves none of them (OAuth only, no OIDC) and answers a
    JSON 404. Left on the web app they 302 to `/login` HTML, and a client fails on `Unexpected token '<'`
    instead of its designed refusal (#1315). The web app owns none of these paths.
  - **Streaming (SSE):** Caddy's `encode` wraps every response **except** streamed ones — the AI run
    event stream (`/api/ai/runs/*/events`), `/mcp`, and any request with `Accept: text/event-stream`. The
    pinned Caddy (v2.11.3) otherwise withholds an SSE response's header until the first event and
    compresses the stream (caddyserver/caddy#6293; the fix, PR #7905, is in no release yet), so the
    carve-out is keyed on the request. `reverse_proxy` flushes `text/event-stream` immediately. No
    stream timeout is set; a Caddy restart drops open streams and the client resumes with
    `Last-Event-ID`. `infra/test/caddy-routing.sh` checks the routing in all three modes and runs the
    pinned Caddy live against a scripted SSE upstream.
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
  Postgres, so its volume **need not be backed up** — on boot the API rebuilds any empty or missing
  index from the database in the background (no manual step), and `reindex:all` forces a full rebuild
  ([[backups]], [[0035-search-architecture]]). The volume is named after the **exact** server version
  (`meili_data_v1_53_2`): a Meilisearch data dir only opens on the engine version that wrote it, so a
  server bump starts on a fresh volume and the index rebuilds itself (ADR-0035 amendment 2026-09-26).
- **Secrets/config:** one `.env` per scope with a committed `.env.example`; the prod
  `infra/env/.env.prod` is gitignored, with `CHANGE_ME` placeholders and host-side protection. No
  Docker secrets block or external manager (YAGNI). New scoped env: **`REDIS_URL`** (the Valkey URL,
  e.g. `redis://valkey:6379`) and **`WORKFLOW_SECRET_KEY`** (the AES-256-GCM key for the workflow
  secret store — 32 bytes / 64 hex via `openssl rand -hex 32`, fail-loud at boot if missing).
  Two **optional** keys for the AI assistant ([[0097-ai-assistant-mcp-and-headless-api]]):
  `AI_SECRET_KEY` (the AES-256-GCM key for the AI provider's API key at rest — its own axis, like
  `SMTP_SECRET_KEY`; without it the API boots unchanged and only saving a provider key 409s) and
  `AI_WORKER_CONCURRENCY` (concurrent AI runs, default 4). Both ship **commented** in the example so the
  guided update never stops an instance that does not use AI; `infra/start.sh` generates `AI_SECRET_KEY`
  on a fresh install and on `--reconfigure`. No new container: AI runs execute in the `api` container.
  One more **optional** key of the same shape for directory sync ([[0091-on-prem-ad-ldap-directory-source]]):
  `DIRECTORY_SECRET_KEY` (the AES-256-GCM key for the LDAP bind password at rest; without it only saving
  a bind password 409s). It also ships **commented**, and `infra/start.sh` generates it on a fresh
  install, on `--reconfigure`, and when re-run on an existing install that lacks it.
  → [[0028-secrets-and-config]].
- **Exposure:** only Caddy publishes ports; Postgres, Meilisearch, Valkey, the API and web stay on the
  internal network. The dev DB, Meilisearch and Valkey bind loopback only.
  → [[0028-secrets-and-config]], SEC-005.
- **Backups:** manual `pg_dump`/`pg_restore` now, automation deferred. **`WORKFLOW_SECRET_KEY` is the
  unrotatable DR linchpin** (alongside `POSTGRES_PASSWORD`): losing it
  makes every stored connector credential undecryptable, so back it up off-host with the *matching*
  DB dump. `SMTP_SECRET_KEY`, `AI_SECRET_KEY` and `DIRECTORY_SECRET_KEY` are low-DR (losing one costs a
  re-typed password or API key) but ride the same `.env.prod` copy. → [[backups]].

## Deployment levels

| Level | What runs | Runbook |
| --- | --- | --- |
| **Dev** | root `compose.yaml` + auto-loaded `compose.override.yaml` (backing services) + `bun run dev` | [[setup]] |
| **LAN (host-agnostic HTTP)** | `compose.yaml` + `infra/docker-compose.prod.yaml` + `--profile prod`, `LAZYIT_SITE_ADDRESS=:80` plain HTTP any-host on the published port, `AUTH_MODE=local` | [[deploy-self-hosted]] |
| **Local prod-like** | `compose.yaml` + `infra/docker-compose.prod.yaml` + `--profile prod`, local HTTPS, high ports 8080/8443 | [[docker-prod-like-first-boot]] |
| **Self-hosted real** | same compose, real domain + Let's Encrypt, real secrets, backups | [[deploy-self-hosted]] |

The network/TLS mode (`lan`/`local`/`real`) is chosen at install; changing it later (or after a DHCP IP
change) is the supported `./infra/start.sh --reconfigure` path — it re-renders `infra/env/.env.prod`
preserving every secret, without touching volumes (local-auth installs only). → [[0087-plain-http-lan-deployment-axis]].

## First deploy — the guided bootstrap (`infra/start.sh`)

The **recommended** first-deploy path is the guided, idempotent, **non-destructive** `infra/start.sh`
([[0047-guided-first-deploy-bootstrap]]) — a thin POSIX-`sh` wrapper over the existing env contract +
prod compose (it adds no app logic and changes no contract). Shape **DETECT → ASK → GENERATE → UP →
POINT**: it checks prerequisites, asks ~6 questions, renders `infra/env/.env.prod` with strong random
secrets (eliminating the classic foot-guns — the `DATABASE_URL`/`POSTGRES_PASSWORD` coupling and the
forgotten `chmod 600`), runs the canonical prod compose, and points the operator at
**`https://<host>/setup`**. Authentication is two-way: built-in accounts (the default) or BYOI, where it
writes the OIDC client values the operator registered in their own IdP. It **never** regenerates an
existing secret (above all the unrotatable `WORKFLOW_SECRET_KEY`) or runs any teardown — a destructive
reset stays a documented manual operation. On an existing install whose env still wires the removed
bundled Zitadel it **refuses** before writing anything (skipped on `AUTH_MODE=local` installs —
[[0102-remove-bundled-zitadel]] §7). The manual
`cp`/`openssl`/`chmod`/`up` steps remain documented as the explicit fallback ([[deploy-self-hosted]],
[[docker-prod-like-first-boot]]).

## CI/CD

CI (GitHub Actions) gates every PR/push: typecheck, lint, test, build, and a Docker image build
(not published). The image builds run **in parallel** (a matrix over `api`/`web`/`migrate`) and
**concurrently with** the verify gate, so the Docker stage is no longer the wall-clock long pole
([[0052-ci-parallel-docker-and-decoupled-verify]]). **CD is deferred** — there's no deploy target
yet; the registry will be GHCR when one exists. → [[0027-ci-pipeline]].

## Identity & authorization (as built)

Auth is **live**, chosen once per instance by `AUTH_MODE` and immutable afterwards
([[0086-local-authentication-mode]]):

- **`local`** (the default) — built-in accounts: lazyit owns the password and mints its own session. No
  IdP.
- **`oidc`** — **BYOI**, your own OIDC IdP (Entra ID, Okta, Keycloak, Authentik…), configured only by
  environment variables. The web signs in through Auth.js with `AUTH_ISSUER` / `AUTH_CLIENT_ID` /
  `AUTH_CLIENT_SECRET` ([[0039-authjs-v5-frontend-oidc]]); the API is a resource server that verifies
  the bearer token against `OIDC_ISSUER` and `OIDC_JWKS_URI` (both required at boot, `OIDC_CLIENT_ID`
  optional as the audience) and never holds a client secret. The IdP `sub` maps to `User.externalId` (JIT
  on first login — [[0038-jit-user-provisioning]]).

No IdP runs in the stack and lazyit **never writes to the IdP**: creating, editing or offboarding a person
changes lazyit only. Offboarding still blocks sign-in to lazyit — by `sub` for a person who signed in
before, and by verified email for one who never did ([[0102-remove-bundled-zitadel]] §5) — while disabling
the IdP account stays the operator's step for every other application the IdP fronts. The API reads the
userinfo endpoint from the issuer's discovery document and sends the access token only there, or to the
`OIDC_JWKS_URI` origin when that is an internal route to a co-located IdP
([[0038-jit-user-provisioning]]). The bundled Zitadel, its
bootstrap sidecar and the `auth.` Caddy site were removed by [[0102-remove-bundled-zitadel]]; the API
refuses to boot under `AUTH_MODE=oidc` while the env still points at them. The first ADMIN is created by
the in-app **`/setup` wizard**, which also shows the BYOI environment snippet (web + API keys).

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

Related: [[stack]] · [[monorepo]] · [[setup]] · [[authorization]] · [[0102-remove-bundled-zitadel]] ·
[[backups]] · [[05-runbooks/_MOC|Runbooks]] · [[0025-containerization-strategy]] ·
[[0026-reverse-proxy-tls]] · [[0027-ci-pipeline]] · [[0028-secrets-and-config]] ·
[[0035-search-architecture]] · [[0086-local-authentication-mode]] ·
[[0047-guided-first-deploy-bootstrap]] · [[0053-async-workers-bullmq-valkey]] ·
[[0054-applications-workflow-engine]] · [[0097-ai-assistant-mcp-and-headless-api]]
