---
title: Deployment
tags: [architecture]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Deployment

> [!warning] Skeleton — not yet decided
> lazyit is self-hosted and internal, but the concrete deployment target has **not** been
> chosen. This note frames the decision; fill it in (and add a runbook under
> [[05-runbooks/_MOC|Runbooks]]) once decided.

## Constraints (from [[vision]])

- **Self-hosted, single-org.** Runs inside the company; not multi-tenant SaaS.
- **Operable by a small team.** Minimal moving parts; boring, durable infrastructure.

## Open questions

- **Topology:** single Docker host (Compose) vs orchestrated (k8s/Nomad)? For 5–20 users,
  a single host with Compose is likely enough.
- **Components to run:** `web`, `api`, Postgres, and (later) Redis + workers.
- **TLS / reverse proxy:** Caddy / Traefik / nginx?
- **Backups:** Postgres backup + restore strategy → must become a [[05-runbooks/_MOC|runbook]].
- **Migrations in prod:** how `prisma migrate deploy` is run on release.
- **Secrets/config:** `.env` management for prod (see [[setup]] for dev).

## Dev today

Local dev uses Docker Compose for Postgres (`postgres:18-alpine`) and `bun run dev` for the
apps. See [[setup]].

Related: [[stack]] · [[monorepo]] · [[setup]]
