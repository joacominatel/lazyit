---
title: Deploy to a Self-Hosted Host
tags: [runbook, docker, deployment]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Runbook — deploy lazyit to a self-hosted host

Install lazyit on a single host (one company = one instance — [[0015-deployment-model]]) on a real
domain with publicly-trusted HTTPS. Same compose as the [[docker-prod-like-first-boot|prod-like
runbook]]; the differences are a real domain, real secrets, and backups.

> [!warning] Auth is not implemented yet
> The current build is **unauthenticated** ([[0016-auth-strategy-deferred]]); the `X-User-Id` shim
> is forgeable by design ([[0022-draft-visibility-auth-shim]]). **Do not expose this build on the
> public internet** until the IdP integration lands. Deploy it on a private network / VPN only.

## Prerequisites

- A host (Linux) with Docker + Docker Compose and the repo (or a built artifact) on it.
- A DNS A/AAAA record pointing your domain at the host, reachable on **:80 and :443** *if* you want
  automatic Let's Encrypt certificates. On a private network, you can keep the internal CA instead.
- A backup location (see [[backups]]).

## 1. Configure environment & secrets

```sh
cp infra/env/.env.prod.example infra/env/.env.prod
chmod 600 infra/env/.env.prod        # restrict on the host — secrets live here (ADR-0028)
```

Edit `infra/env/.env.prod`:

- `POSTGRES_PASSWORD` — a strong, unique password. **Never** the example value.
- `DATABASE_URL` — same password, host `db` (e.g. `postgresql://lazyit:<pw>@db:5432/lazyit?schema=public`).
- `LAZYIT_SITE_ADDRESS` — your FQDN (e.g. `lazyit.example.com`).
- `WEB_ORIGIN` — `https://lazyit.example.com` (no trailing slash).
- `LAZYIT_TLS_EMAIL` — your ops email, **and** uncomment the `email` line in `infra/caddy/Caddyfile`
  to enable Let's Encrypt. (Skip both to keep Caddy's internal CA on a private network.)
- Ports: keep `LAZYIT_HTTP_PORT=80` / `LAZYIT_HTTPS_PORT=443` for a public host (override the
  high-port defaults), or keep the high ports behind another proxy.

> [!info] Secrets handling
> `.env.prod` is gitignored and never committed. There is no Docker secrets block or external
> manager by decision ([[0028-secrets-and-config]]); protect the file with host permissions and
> back it up out-of-band. Rotating a secret = edit the file + `up -d` to recreate the affected
> services.

## 2. Bring it up

```sh
docker compose -f infra/docker-compose.prod.yml up -d --build
docker compose -f infra/docker-compose.prod.yml ps          # all healthy; migrate exited 0
```

Caddy obtains a certificate automatically (Let's Encrypt for a public FQDN on :443, or its internal
CA otherwise). The one-shot `migrate` service applies migrations and seeds before the API starts.

## 2a. Populate search indices (first deploy only)

After the stack is healthy (all services up, `migrate` exited 0), run the full re-index once to
populate Meilisearch with existing data ([[0035-search-architecture]]):

```sh
docker compose -f infra/docker-compose.prod.yml exec api bun run reindex:all
```

This is a one-time step on first deploy, or after adding Meilisearch to an existing instance.
Subsequent deploys do not need it — the API keeps Meili in sync incrementally. The API's
`SearchService` is fail-soft: if Meilisearch is unreachable, search calls no-op and the app
continues to function ([[0035-search-architecture]]).

## 3. Verify

```sh
curl -so /dev/null -w "web: %{http_code}\n"  https://lazyit.example.com/
curl -s            -w "\napi: %{http_code}\n" https://lazyit.example.com/api/users
```

## 4. Updating to a new version

```sh
git pull                                                       # or ship a new build/image
docker compose -f infra/docker-compose.prod.yml up -d --build  # rebuilds; migrate re-runs (deploy)
```

New migrations are applied automatically by the `migrate` job on the next `up` (it runs
`prisma migrate deploy` — never `migrate dev`/`reset` in production; [[prisma-migrations]]).
**Back up the database before any update** ([[backups]]).

## 5. Backups

Configure database backups before real use — see **[[backups]]** (pg_dump/restore). Also back up
`infra/env/.env.prod` (secrets) somewhere safe and access-controlled.

## Reserved for later — the IdP

When auth lands ([[0016-auth-strategy-deferred]]): a self-hosted IdP (Authentik/Keycloak/Zitadel —
TBD) gets a service in the compose file and a route in the `Caddyfile` (a commented stub is already
there), and the API validates OIDC tokens, mapping the IdP `sub` to `User.externalId`. The
`OIDC_*` placeholders in `.env.prod.example` are reserved for that. No action needed now.

Build/boot problems → [[docker-build-troubleshooting]].

Related: [[deployment]] · [[docker-prod-like-first-boot]] · [[backups]] · [[prisma-migrations]] ·
[[0015-deployment-model]] · [[0026-reverse-proxy-tls]] · [[0028-secrets-and-config]]
