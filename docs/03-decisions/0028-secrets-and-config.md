---
title: "ADR-0028: Secrets & configuration management"
tags: [adr, infra, secrets, security]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0028: Secrets & configuration management

## Status

accepted

## Context

Containerizing lazyit ([[0025-containerization-strategy]]) raises *where configuration and secrets
live* across the three levels (dev, local prod-like, self-hosted real). Today dev uses one `.env`
per scope, each with a committed `.env.example` ([[setup]]). We must extend this to prod without
over-engineering — lazyit is self-hosted and single-org ([[0015-deployment-model]]), so an external
secrets manager (Vault, cloud KMS) would add a dependency the target operator does not want.

This ADR also captures the hardening that closes **SEC-005** (Postgres exposed on all host
interfaces with trivial example credentials).

## Considered options

- **External secrets manager (Vault / cloud KMS)** — strong, but a heavy external dependency that
  fights the self-hosted, small-team target. Premature (YAGNI).
- **Docker Compose secrets (file-based) everywhere** — closer to "prod-grade", but adds friction to
  the local prod-like bring-up for little gain at this scale.
- **`.env` files per level + committed `.env.example`** *(chosen)* — the same mechanism as dev,
  extended: real `.env*` are gitignored, examples carry `CHANGE_ME` placeholders, and the operator
  protects the host `.env` (file permissions). Leaves the door open to Docker secrets / a manager
  later without locking it in.

## Decision

- **Configuration is by `.env` per level**, each with a committed `*.example`:
  - dev: root `.env` (Postgres) + `apps/api/.env` (`DATABASE_URL`, `PORT`, `WEB_ORIGIN`, …).
  - prod-like / self-hosted: **`infra/env/.env.prod`** (gitignored), copied from
    **`infra/env/.env.prod.example`**.
- **Secrets are never committed and never trivial, even in examples.** Example files use explicit
  **`CHANGE_ME`** placeholders with a note that real values go in the gitignored `.env*` and that the
  operator must restrict its permissions (`chmod 600`) on the host.
- **No Docker Compose `secrets:` block and no external manager** for now (the user's explicit choice).
  Documented as the path to adopt later if requirements grow.
- **Network exposure is least-privilege:** no service binds all host interfaces unless required.
  - **prod-like / self-hosted:** Postgres, API and web are **not published** — they live on the
    internal compose network; only Caddy publishes ports ([[0026-reverse-proxy-tls]]).
  - **dev:** Postgres is bound to **loopback** (`127.0.0.1:5432:5432`), not `0.0.0.0`, so the dev DB
    is not reachable from the LAN. (`localhost` connections are unaffected → zero developer impact.)

### Hardening applied (closes SEC-005)

SEC-005 flagged the dev compose publishing `5432:5432` (all interfaces) with `postgres:postgres`
example credentials, and warned the default must not carry into a production topology. Applied:

1. **Dev compose** binds Postgres to `127.0.0.1` only.
2. **Prod-like / self-hosted** never publishes Postgres — internal network only.
3. **Example creds are placeholders** (`CHANGE_ME`) with a "production must never expose 5432 nor
   reuse example credentials" note; Postgres still **fails closed on an empty password**.

The dev `apps/api/.env.example` (`postgres:postgres`) lives in the application lane and is left as a
deliberate dev convenience; its LAN-exposure risk is removed by the loopback bind above.

## Consequences

- **Positive:** one consistent, dependency-free mechanism across levels; secrets stay out of git and
  off the LAN; the deployment review can assert "no 0.0.0.0 binds, no trivial secrets, DB private".
- **Trade-offs:** the operator is responsible for protecting the host `.env` (no manager enforcing
  it); rotating secrets is manual.
- **Follow-ups:** adopt Docker secrets or an external manager if/when scale or compliance demands it;
  revisit when the IdP integration lands (it will add OIDC client secrets — placeholders are reserved,
  commented, in `.env.prod.example`).

Related: [[0025-containerization-strategy]] · [[0026-reverse-proxy-tls]] · [[0015-deployment-model]] ·
[[0016-auth-strategy-deferred]] · [[setup]] · [[deployment]]
