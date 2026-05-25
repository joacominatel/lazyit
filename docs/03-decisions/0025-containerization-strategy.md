---
title: "ADR-0025: Containerization & image strategy"
tags: [adr, infra, docker]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0025: Containerization & image strategy

## Status

accepted

## Context

lazyit is **self-hosted, single-org** ([[0015-deployment-model]]) and needs to ship as containers
an operator can run on a single host with Docker Compose. Until now there was only the dev
`docker-compose.yml` (Postgres). We must decide *how* `apps/api`, `apps/web` and the database
migrations get built into images, on which base images, and how the runtime/build split works —
without contradicting the **Bun-is-scoped** rule ([[0009-bun-first-vs-app-stack]]): Bun is the
build/tooling default, the app **runtime** is Node + Prisma.

Constraints discovered in the repo:

- The API's production start is `node dist/main` — **Node runtime**, not Bun.
- Prisma 7 uses the `prisma-client` generator with the **`@prisma/adapter-pg` driver adapter**,
  so there is **no Rust query engine binary at runtime**; the generated client
  (`apps/api/generated/prisma`, gitignored) is portable JS that must be produced by
  `prisma generate` at build time.
- The seed is `bun prisma/seed.ts` → seeding **requires Bun**, even though the API runtime is Node.
- Workspaces use `workspace:*`; both apps depend on `@lazyit/shared`, which builds to `dist/`.
- Next.js can emit a self-contained server with `output: 'standalone'` (needs a one-line app config).

## Considered options

- **Single base for build and runtime (Bun everywhere)** — would mean running the API on Bun,
  contradicting [[0009-bun-first-vs-app-stack]] and [[0002-nestjs-backend]]. Rejected.
- **Node for both build and runtime** — workable, but loses Bun's faster, repo-pinned install and
  the `bun test`/tooling parity used elsewhere. Build would drift from how developers build locally.
- **Multi-stage: Bun builder → Node runtime** *(chosen)* — build (`bun install`, `prisma generate`,
  `nest build` / `next build`) on the repo-pinned `oven/bun:1.3.14`; copy only built artifacts +
  production deps into a minimal `node:26-alpine` runtime. Matches the scoped Bun decision exactly.

## Decision

- **Per-app multi-stage Dockerfiles** in `infra/docker/` (`api.Dockerfile`, `web.Dockerfile`,
  `migrate.Dockerfile`), built with **context = repo root** and `-f infra/docker/<x>.Dockerfile .`
  (workspaces need the whole monorepo). Dockerfiles **read** app code via `COPY`; they never modify it.
- **Builder stage:** `oven/bun:1.3.14` (Debian/glibc). Installs with `bun install --frozen-lockfile`,
  builds `@lazyit/shared`, runs `prisma generate`, then `nest build` (api) / `next build` (web).
- **API runtime:** `node:26-alpine`, runs `node apps/api/dist/main` as a non-root user. Carries the
  built `dist/`, the generated Prisma client, `packages/shared/dist`, and **production** node_modules.
- **Web runtime:** `node:26-alpine`, runs the Next.js **standalone** server (`output: 'standalone'`).
  This needs a one-line change in `apps/web/next.config.ts` (application lane) — made as an
  **authorized cross-lane exception**, committed separately.
- **Migrations + seed:** a **one-shot job** on `oven/bun:1.3.14` running
  `prisma migrate deploy && prisma db seed`. It runs after Postgres is healthy and before the API
  starts (`depends_on: condition: service_completed_successfully`). Bun is required for the seed;
  Debian (glibc) is required so the Prisma **schema engine** (used by `migrate deploy`) finds its
  binary without the Alpine/musl OpenSSL pitfall. Background: [[prisma-migrations]].
- **Hardening:** non-root users, a healthcheck on every long-running service (API/Web via a small
  `node -e http.get` probe; Postgres via `pg_isready`), named volumes for state.

### Why Node 26 (and Alpine)

`node:26-alpine` exists and is the version the stack targets ([[stack]]). Node 26 was released in
April 2026 (Current line) and enters Active LTS in October 2026; we accept the short Current window
in exchange for aligning the image with the documented target and `@types/node`. **Alpine is safe
here** specifically because the Prisma driver-adapter removes the native query-engine binary — the
classic "Alpine + musl + OpenSSL breaks Prisma" problem does not apply to the **runtime** image.
The only place that still needs a Prisma engine binary is `migrate deploy`, which is why the
**migrate job uses Debian-based `oven/bun`**, not Alpine. If a future Node 26 image regression
appears, fall back to `node:lts-alpine`; the runtime client is portable JS either way.

## Consequences

- **Positive:** small runtime images; build matches local dev (Bun); honours the Bun-scoped rule;
  migrations/seed are explicit, idempotent and ordered; no query-engine binary to ship for the API.
- **Trade-offs:** the web image depends on a one-line app-lane change (`output: 'standalone'`);
  two base families in play (Bun-Debian for build/migrate, Node-Alpine for runtime); Node 26 is
  Current-not-yet-LTS until Oct 2026.
- **Follow-ups:** pin base images by digest as a future hardening; image **publishing** to a registry
  (GHCR) is deferred with CD ([[0027-ci-pipeline]]). The reverse proxy / routing is
  [[0026-reverse-proxy-tls]]; secrets/config is [[0028-secrets-and-config]].

Related: [[0009-bun-first-vs-app-stack]] · [[0015-deployment-model]] · [[deployment]] ·
[[prisma-migrations]] · [[stack]] · [[0026-reverse-proxy-tls]] · [[0027-ci-pipeline]] ·
[[0028-secrets-and-config]]
