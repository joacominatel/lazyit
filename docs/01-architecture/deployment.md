---
title: Deployment
tags: [architecture]
status: accepted
created: 2026-05-25
updated: 2026-05-25
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
                          │    │ /api/docs*   ─▶ api :3001 (Swagger, passthrough)
                          │   api ──▶ db :5432 (Postgres 18)               │
                          │   migrate (one-shot: prisma migrate deploy + seed)
                          │   internal network — only Caddy publishes ports │
                          └────────────────────────────┘
```

- **Components:** Postgres, a one-shot **migrate** job, the **API**, the **web** app, and **Caddy**.
  (Later: Redis + async workers — [[stack]].)
- **Images:** multi-stage, built with Bun, run on Node (`node:26-alpine`); the API runs
  `node dist/src/main`, the web runs the Next.js standalone server. The migrate job runs on Bun
  (the seed needs it). Details: [[0025-containerization-strategy]].
- **Reverse proxy / TLS:** **Caddy** with automatic HTTPS — internal CA for local prod-like,
  Let's Encrypt for a real domain. **Same-origin routing**: the browser calls `/api/*` and Caddy
  forwards it to the API, so the web image is domain-portable (`NEXT_PUBLIC_API_URL=/api`, baked at
  build). Details: [[0026-reverse-proxy-tls]].
- **Migrations in prod:** the `migrate` job runs `prisma migrate deploy` (never `migrate dev`/
  `reset`) then the idempotent seed, before the API starts. → [[prisma-migrations]].
- **Secrets/config:** one `.env` per scope with a committed `.env.example`; the prod
  `infra/env/.env.prod` is gitignored, with `CHANGE_ME` placeholders and host-side protection. No
  Docker secrets block or external manager (YAGNI). → [[0028-secrets-and-config]].
- **Exposure:** only Caddy publishes ports; Postgres/API/web stay on the internal network. The dev
  DB binds loopback only. → [[0028-secrets-and-config]], SEC-005.
- **Backups:** manual `pg_dump`/`pg_restore` now, automation deferred. → [[backups]].

## Deployment levels

| Level | What runs | Runbook |
| --- | --- | --- |
| **Dev** | root `docker-compose.yml` (Postgres) + `bun run dev` | [[setup]] |
| **Local prod-like** | `infra/docker-compose.prod.yml`, local HTTPS, high ports 8080/8443 | [[docker-prod-like-first-boot]] |
| **Self-hosted real** | same compose, real domain + Let's Encrypt, real secrets, backups | [[deploy-self-hosted]] |

## CI/CD

CI (GitHub Actions) gates every PR/push: typecheck, lint, test, build, and a Docker image build
(not published). **CD is deferred** — there's no deploy target yet; the registry will be GHCR when
one exists. → [[0027-ci-pipeline]].

## Reserved, not configured — the IdP

Auth is deferred to an external IdP ([[0016-auth-strategy-deferred]]). Infra leaves a **slot**: a
commented service in the compose file, a commented route in the `Caddyfile`, and commented `OIDC_*`
placeholders in `.env.prod.example`. When it lands, the IdP `sub` maps to `User.externalId`. The
provider (Authentik/Keycloak/Zitadel) is a future ADR.

## Open questions

- **CD pipeline** — registry (GHCR) + deploy flow + image tagging, once a target exists.
- **Backup automation** — scheduled + offsite, when there's a real deployment ([[backups]]).
- **Async workers** — BullMQ + Redis topology, when adopted ([[stack]]).

Related: [[stack]] · [[monorepo]] · [[setup]] · [[05-runbooks/_MOC|Runbooks]] ·
[[0025-containerization-strategy]] · [[0026-reverse-proxy-tls]] · [[0027-ci-pipeline]] ·
[[0028-secrets-and-config]]
