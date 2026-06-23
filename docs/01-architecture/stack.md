---
title: Tech Stack
tags: [architecture]
status: accepted
created: 2026-05-25
updated: 2026-06-23
---

# Tech Stack

Versions below are **verified against the repository** as of 2026-06-23, not just planned.

| Layer | Choice | Version | Notes |
| --- | --- | --- | --- |
| Package manager / runtime | **Bun** | `1.3.14` | Workspaces; default runtime — see [[0001-monorepo-bun-turborepo]] |
| Monorepo orchestration | **Turborepo** | `^2.9` | `turbo dev` / `turbo build` / `turbo lint` |
| Frontend | **Next.js** (App Router) | `16.2.9` | React `19.2.4`, Tailwind v4, shadcn/ui, TypeScript |
| Backend | **NestJS** | `11.0.1` | `@nestjs/platform-express`, TypeScript strict |
| ORM | **Prisma** | `7.8.0` | `prisma-client` generator → `apps/api/generated/prisma` |
| Database | **PostgreSQL** | `18-alpine` | Docker Compose for dev — see [[0003-prisma-orm]] |
| Search engine | **Meilisearch** | `v1.12.3` | Article/asset full-text search — see [[0035-search-architecture]] |
| Queue broker | **Valkey** (Redis-compatible) | `8-alpine` | Backs BullMQ; AOF persistence — see [[0053-async-workers-bullmq-valkey]] |
| Async workers | **BullMQ** + `@nestjs/bullmq` | — | ioredis client; sandboxed processors for heavy/untrusted jobs |
| Shared types | **`@lazyit/shared`** | `0.0.0` | `packages/shared`; zod schemas/types shared front↔back |
| Node (runtime image) | Node | `26-alpine` | Digest-pinned base for the prod images — see [[0025-containerization-strategy]]; `@types/node` is `^24.0.0` in both api and web |

## Ports

- Web (Next.js): `http://localhost:3000`
- API (NestJS): `http://localhost:3001`
- Postgres: `5432`
- Meilisearch: `7700` (loopback-only in dev; internal-network-only in prod)
- Valkey: `6379` (loopback-only in dev; never published in prod)

## Async workers & queue

lazyit runs a **durable background-job substrate — BullMQ on a self-hosted Valkey** (the
Redis-compatible BSD fork), wired through **`@nestjs/bullmq`** (ioredis client) with **PostgreSQL
as the system of record**. The rule is **"BullMQ executes; PostgreSQL remembers"**: a queued job
carries only an id, while run state, idempotency keys and the audit ledger live in Postgres — so a
Valkey flush is a *reconcile/replay*, not data loss, and the executor stays swappable. Valkey runs
with **AOF persistence** so queued jobs survive a restart. This is **shipped**, not planned.
Rationale (Valkey over Redis/Dragonfly, BullMQ over pg-boss, sandboxed processors for the dangerous
work): [[0053-async-workers-bullmq-valkey]] (**accepted — built**).

Two workloads ride this substrate today:

- **Async `.docx` knowledge-base import.** `POST /articles/import` validates type/size, enqueues the
  file and returns `202 { jobId }`; the parse runs in a **sandboxed, heap-capped processor** (a
  forked child with `--max-old-space-size`) so a decompression bomb crashes the child, not the API,
  and the web client **polls** a status endpoint until the article is ready. This closed **SEC-002**.
- **The Applications Workflow Engine** — the `WorkflowEngineModule` (run **orchestrator** + the
  `workflow-run` BullMQ **worker** + the REST / WEBHOOK_OUT / MANUAL **connectors**). Per-application
  and **opt-in**: when access is granted/revoked, an admin-configured workflow provisions /
  deprovisions the user in an external system (Jira / Redmine / any REST or webhook target) via an
  **opinionated error-handling DAG**. The engine fires **after the grant transaction commits**,
  decoupled by a transactional outbox, so a failing external call never blocks or rolls back the
  access grant (the deliberate inverse of the synchronous Zitadel write-back). Its front↔back
  contracts live in `@lazyit/shared` ([[shared-package]]). Data model, contracts and execution
  semantics: [[0054-applications-workflow-engine]]; full design vault:
  [[workflow-engine/_MOC|Workflow Engine]].

> [!note] Honest scope (engine v1)
> The engine is **new** — shipped, not yet battle-tested in production. Run and manual-task status are
> surfaced by **polling** (no SSE / notification bell yet); v1 connectors are **public-https
> REST / WEBHOOK_OUT / MANUAL** only; on-prem / internal-target connectors, timer / scheduled triggers
> and the SDK / MCP / prebuilt connector tiers are **future** (reserved enum slots). The manual-task
> inbox is a provisioning queue, **not** a generic ticketing / approval / IGA system. → §6–7 of
> [[0054-applications-workflow-engine]].

## Search

lazyit runs a dedicated **full-text search engine — Meilisearch** (`getmeili/meilisearch:v1.12.3`,
digest-pinned) alongside Postgres, indexing the knowledge-base articles and assets. The API talks to it
through the official `meilisearch` client in `apps/api/src/search/`; **PostgreSQL stays the system of
record** and the Meili index is a **rebuildable projection** of it. The search is **fail-soft**: when
Meili is down the API **no-ops** rather than erroring, and the whole index can be reconstructed from
Postgres with the `reindex:all` script (a **one-off reindex is required after the first deploy**, and
after a Meili volume rebuild). Because the index is rebuildable, its volume **need not be backed up**.
This is **shipped**, not planned. Rationale and index/reconcile design:
[[0035-search-architecture]] (**accepted — built**).

## Authentication & authorization

Auth is **live**, not deferred. The IdP is **Zitadel** — bundled by default with a **BYOI**
(bring-your-own-OIDC) escape hatch so an operator can point lazyit at their own provider
([[0037-idp-choice-zitadel-byoi]], [[0043-zitadel-source-of-truth]]). The Next.js frontend drives the
OIDC flow with Auth.js v5 ([[0039-authjs-v5-frontend-oidc]]). **Authorization** is DB-first
fine-grained permissions, entirely lazyit-local (never synced to the IdP, so it rides BYOI unchanged).
Topology, source-of-truth split and gotchas: [[auth-zitadel-sot]], [[authorization]].

> [!warning] Bun-first vs app stack
> The repo's `CLAUDE.md` mandates `Bun.serve`, `Bun.sql`, `Bun.redis` and `bun test`, but
> the chosen app stack is NestJS (Express) + Prisma + Jest. Resolved in
> [[0009-bun-first-vs-app-stack]] (accepted): Bun is the **runtime, package manager and
> tooling default**, *not* the server/DB API layer. The scoped rule lives in `CLAUDE.md`.

## Why these

Each significant choice has an ADR:
[[0001-monorepo-bun-turborepo]] · [[0002-nestjs-backend]] · [[0003-prisma-orm]] ·
[[0010-nextjs-frontend]] · [[0011-tailwind-styling]] · [[0012-testing-strategy]] ·
[[0025-containerization-strategy]] · [[0035-search-architecture]] ·
[[0037-idp-choice-zitadel-byoi]] · [[0039-authjs-v5-frontend-oidc]] ·
[[0043-zitadel-source-of-truth]] · [[0053-async-workers-bullmq-valkey]] ·
[[0054-applications-workflow-engine]].

Related: [[monorepo]] · [[shared-package]] · [[deployment]] · [[workflow-engine/_MOC|Workflow Engine]]
