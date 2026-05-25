---
id: SEC-005
title: docker-compose publishes Postgres on all host interfaces with trivial example credentials
severity: low
status: open
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
