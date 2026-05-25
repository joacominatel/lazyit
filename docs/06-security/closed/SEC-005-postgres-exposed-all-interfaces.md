---
id: SEC-005
title: docker-compose publishes Postgres on all host interfaces with trivial example credentials
severity: low
status: fixed
cwe: CWE-1327
discovered: 2026-05-25
module: infra
tags: [insecure-default, exposure, docker, hardening]
---

# SEC-005 — Postgres bound to 0.0.0.0:5432 with trivial dev credentials

## Summary

The dev `docker-compose.yml` maps `5432:5432`, binding Postgres to every interface of the host, and the
committed example `DATABASE_URL` uses `postgres:postgres`. On any non-isolated network the dev DB is
directly reachable with guessable credentials.

## Description

`docker-compose.yml:12-13`:

```yaml
ports:
  - 5432:5432        # == 0.0.0.0:5432, not 127.0.0.1
```

`apps/api/.env.example:7` steers the password to the trivial `postgres`
(`postgresql://postgres:postgres@localhost:5432/lazyit`). The compose password has no default
(`POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}`) and the root `.env.example` ships it empty — good, Postgres
fails closed on an empty password — but the api example points everyone at `postgres`. Net effect: a
dev who follows the examples runs an all-interfaces Postgres with password `postgres`. Direct DB access
bypasses any (future) application-layer guard and exposes/edits all data.

## Impact

Low, and dev-scoped — but explicitly in review scope. On a shared office/VPN/coffee-shop network the DB
is reachable and the credentials are guessable. There is no production topology yet (ADR-0015 is the
model, not a deployment); the concern is that this default must not carry into one.

## Proof of concept

Reasoned, **not executed**: from another host on the same network,
`psql postgresql://postgres:postgres@<dev-host-lan-ip>:5432/lazyit`.

## Affected

- `docker-compose.yml:12-13` — `5432:5432` (all interfaces).
- `apps/api/.env.example:7` — example creds `postgres:postgres`.
- `.env.example:4` — `POSTGRES_PASSWORD=` (empty; fails closed, but pair it with a real value).

## Recommendation

- Bind to loopback for dev: `"127.0.0.1:5432:5432"`.
- Use a non-trivial password even in dev examples (or a clearly-throwaway generated one), with a comment
  that production must never expose 5432 nor reuse the example creds.
- When a deploy topology is written (ADR-0015 follow-up), keep the DB on a private network only.

## Prevention

Make "no service binds 0.0.0.0 unless required; secrets are never trivial even in examples" part of the
compose/deploy review. Revisit in the deployment ADR.

## References

- CWE-1327: Binding to an Unrestricted IP Address. CWE-668: Exposure of Resource to Wrong Sphere.
- ADR-0015 (deployment model) · docs/04-development/setup.md.

## Triage note

Out of lane → **DevOps**. `module: infra` (`docker-compose.yml` + `.env.example`) is owned by the
parallel `lazyit-devops` agent, not the remediator. Not remediated here; routed to DevOps.

## Resolution

**Status**: fixed
**Fixed in**: commits `e18576f` (dev DB → loopback) · `76e9eee` (root `.env.example` hardening
note) · `f548ffc` (prod compose: Postgres on the internal network, no host port) · `7ffb099`
(prod env template with `CHANGE_ME` placeholders) · `5f7f736` (ADR-0028 documents the practice)
**Fixed by**: lazyit-devops
**Date**: 2026-05-25

### Changes

Addresses all three of the finding's recommendations across both the dev and the new
production-shaped stack ([[0028-secrets-and-config]]):

- **Dev DB no longer binds all interfaces.** `docker-compose.yml` now publishes
  `"127.0.0.1:5432:5432"` (loopback only) — the dev database is unreachable from the LAN, while
  `localhost` connections are unchanged (zero developer impact). The running dev container keeps its
  old mapping until its next recreate; the change applies on the next `up`.
- **Production never exposes Postgres at all.** `infra/docker-compose.prod.yml` puts `db` (and
  `api`/`web`) on an internal compose network with **no `ports:`** — only Caddy publishes host
  ports. Verified live: `lazyit-prod-db-1` reports `5432/tcp` with the host mapping `null`.
- **No trivial secrets in examples.** `infra/env/.env.prod.example` uses explicit `CHANGE_ME`
  placeholders (real values go in the gitignored `infra/env/.env.prod`, `chmod 600`), and the root
  `.env.example` now warns that production must never expose 5432 nor reuse example credentials.
  Postgres still fails closed on an empty password.

### Residual / out of lane

- `apps/api/.env.example` still points the dev `DATABASE_URL` at `postgres:postgres`. That file is
  in the **application** lane (not DevOps) and is a deliberate dev convenience; its LAN-exposure
  vector is removed by the loopback bind above. Left for an in-lane agent if a non-trivial dev
  example is wanted.

### Re-verification

Brought up the full prod-like stack (`infra/docker-compose.prod.yml`): `db` healthy with no host
port mapping; the only host-published ports belong to Caddy (`8080`/`8443`). Dev `docker-compose.yml`
still validates and the dev container is undisturbed.
