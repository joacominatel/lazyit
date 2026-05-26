# System Map

> This document is the CTO's mental model of the entire lazyit system: what exists, where it lives, how parts connect, and what state each module is in. It is the **first reference loaded** at every CTO session.
>
> **Not redundant with `docs/`**: that documents the system formally and per-module. This file is the CTO's cross-cutting condensed view — the version that answers "do I understand the whole system enough to coordinate work on it?"
>
> **Owner**: CTO. Initially populated during the first investigation session. Updated at the end of every session where the system changed materially.

---

## How to read this file

This file is structured for **scanning, not reading end-to-end**. The CTO opens it, jumps to the section relevant to the current task, and decides from there.

When investigating something not yet in this file, the CTO is expected to:
1. Read the actual code or docs to find the answer
2. Update this file with the new knowledge before the next session

---

## High-level shape

> **Monorepo**: Bun workspaces + Turborepo
> **Apps**: `apps/api` (NestJS), `apps/web` (Next.js)
> **Shared**: `packages/shared` (zod schemas, types, utilities)
> **Infra**: `infra/` (Docker prod compose, Caddy, env)
> **Docs**: `docs/` (Obsidian vault)
> **Skills**: `.claude/skills/` (this skill and others)

For deeper structure: `docs/01-architecture/monorepo.md`.

---

## Backend (`apps/api`)

### Framework and runtime

- NestJS application
- Runs on Node 26 in production (per ADR-0009)
- Built with Bun (tooling), but executes under Node at runtime
- Entry point: `apps/api/src/main.ts`
- Module registry: `apps/api/src/app.module.ts`

### Modules currently registered

> Filled in by the CTO during investigation. For each module, note:
> - Module name and folder
> - Primary entities it owns
> - Public endpoints
> - Status (stable / new / in flux)

Pending population.

### Cross-cutting middleware and global services

> Pino logger, soft-delete extension, exception filters, validation pipes, ActorService, search sync, etc.
> The CTO must enumerate what wraps every request and what's globally available.

Pending population.

### Database

- PostgreSQL via Prisma (with `@prisma/adapter-pg`)
- Schema at `apps/api/prisma/schema.prisma`
- Migrations at `apps/api/prisma/migrations/`
- Seed script at `apps/api/prisma/seed.ts`

### Auth status

- Currently pre-auth
- Shim header `X-User-Id` simulates the authenticated user (ADR-0022)
- `ActorService` is the central resolver of the shim → User
- All write endpoints require the shim header to be set
- Drafts in KB respect the shim (only the author sees their own drafts)
- The `User.externalId` field is reserved for the future IdP `sub` claim

---

## Frontend (`apps/web`)

### Framework

- Next.js (App Router)
- Tailwind v4 + shadcn/ui (preset `radix-nova`, base `neutral`)
- TanStack Query for data layer
- react-hook-form + zodResolver for forms
- next-themes for dark mode
- Sonner for toasts
- heroicons exclusively (lucide allowed only inside vendored shadcn `components/ui/*`)

### Route groups

- `(app)` — authenticated app (currently shimmed)
- `(auth)` — login flow (skeleton, not wired)
- `(marketing)` — landing / public surface

### Live screens

> The CTO enumerates what is visibly working, what is in flux, and what is planned.

Pending population.

### Shared components and primitives

> ResourceTable, DeleteConfirmDialog, UserAvatar, UserSwitcher, etc.
> The CTO lists what's reusable, where it lives, and what conventions it imposes.

Pending population.

### Data layer convention (ADR-0020)

- `lib/api/endpoints/*.ts` — pure fetch wrappers
- `lib/api/hooks/*.ts` — TanStack Query hooks
- `lib/api/query-keys.ts` — query key factory per entity
- Pages and components consume hooks; never call endpoints directly

---

## Shared (`packages/shared`)

- Compiled CJS + d.ts (per ADR-0014)
- zod schemas (one file per entity)
- Constants
- Pure utilities (slug, etc.)
- Exported via barrel `src/index.ts`

When the CTO sees a schema change proposed, it must know whether the schema lives in shared (cross-cutting) or in api (server-only).

---

## Infrastructure

### Local dev

- `docker-compose.yml` at the repo root
- Currently includes: Postgres, Meilisearch
- `bun run dev` runs api + web natively, expects compose to be up

### Production-like

- `infra/docker-compose.prod.yml`
- Includes: Postgres, api, web, migrate (one-shot), Caddy (reverse proxy)
- **Pending**: Meilisearch in the prod compose (sub-task for DevOps)
- **Pending**: Identity provider in the prod compose (auth epic)

### CI

- GitHub Actions at `.github/workflows/ci.yml`
- Runs on: push to `master`/`dev`, PRs targeting `master`/`dev`
- Jobs: verify (typecheck, lint, tests, build), docker (build images, no push)

### Branching

- `master` = production (protected)
- `dev` = integration
- `<type>/issue-<n>-<slug>` per task

---

## Domain entities

> The CTO maintains a one-paragraph description of each major entity: what it is, its key fields, its relations, and any non-obvious rules (soft-delete vs append-only, etc.).

Pending population. Source of truth: `docs/02-domain/`.

---

## Cross-cutting concerns

### Soft-delete

- Implemented via Prisma `$extends` middleware
- Filters `deletedAt: null` on every query automatically
- Escape hatch: `includeSoftDeleted: true` flag
- Append-only tables (AssetAssignment, AssetHistory, AccessGrant, ConsumableMovement) do NOT soft-delete

### Logging

- Pino + nestjs-pino
- Pretty in dev, JSON in prod
- Request-ID propagated end-to-end
- Bodies NOT logged by default (security decision, ADR-0031)

### Validation

- nestjs-zod + createZodDto
- All endpoints typed via shared zod schemas

### Search

- Meilisearch (external service)
- Synced via service-layer events (fail-soft)
- Endpoint: `GET /search?q=&entities=&limit=20`
- Drafts excluded from index (respects ADR-0022)

### Actor resolution

- `ActorService` centralizes shim → User lookup
- Used by: Assets, AssetAssignments, AccessGrants, Articles, AssetHistory
- Will be replaced by `@CurrentUser()` decorator when auth lands

---

## Known debt

> The CTO catalogs known debt as it discovers it. Each entry: brief description, severity, why it's deferred, when to revisit.

Pending population. Some known items:

- Lint warnings (~168) preexisting, CI non-blocking
- `noUncheckedIndexedAccess` in shared not enforced at build (safe gap)
- Jest doesn't run under Bun locally; userland Node setup required
- `AccessGrantsService` ActorService migration (resolved, but verify in code)
- SEC-002 (.docx decompression bomb) deferred to BullMQ infra
- SEC-003 (markdown sanitization) deferred to frontend DOMPurify pass
- Meilisearch not in prod compose yet
- Auth shim ADR-0022 active until IdP ships

---

## Pending major decisions

> Strategic decisions surfaced but not yet made. The CTO must escalate before any of these become implicit.

- Choice of IdP (Zitadel candidate; in discussion)
- IdP database: shared with app Postgres or its own?
- Bring-your-own-IdP configuration surface design
- Whether to introduce a job queue (BullMQ vs Postgres-backed)
- Whether to add Settings backend (deferred, decision tabled)
- Frontend pagination implementation (contract defined in ADR-0030, not built)

---

## Update protocol

The CTO updates this file when:
- A new module is added
- An entity is added, renamed, or restructured
- A cross-cutting concern is introduced (new middleware, new service)
- A major architectural decision lands
- Known debt is added or resolved
- A pending decision moves to decided

Updates are **append-and-revise**, never wholesale rewrites. Keep the structure; refine the content.

Stale system-map = degraded CTO. The CTO is judged in part by how current this file is.