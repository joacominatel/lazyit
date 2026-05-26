---
title: "ADR-0035: Cross-cutting search architecture (Meilisearch)"
tags: [adr]
status: accepted
created: 2026-05-26
updated: 2026-05-26
deciders: [Joaquín Minatel]
---

# ADR-0035: Cross-cutting search architecture (Meilisearch)

## Status

accepted — 2026-05-26. Fifth and final front of the backend-completion epic (#4, sub-issue #13).
Introduces an external search engine and a service-layer sync; coexists with the soft-delete
extension ([[0032-soft-delete-middleware]]) and the structured logging ([[0031-logging-strategy]]).

## Context

The app needs **one** search box spanning [[asset]], [[article]], [[user]], [[location]] and
[[application]]. The only search today is per-entity `ILIKE` substring (`GET /assets?q=`), unindexed
and not unified. We want typo-tolerant, ranked, fast, cross-entity search behind a single endpoint.

## Considered options

**(1) Engine — Postgres full-text search vs an external engine.** PG FTS avoids a new service but is
clumsy for typo tolerance, ranking and a unified multi-entity query. → **Meilisearch** (decided in the
epic brief): purpose-built, typo-tolerant, multi-index, trivial to operate.

**(2) DB → index sync — triggers/CDC vs service-layer events.** Triggers/CDC are heavy and couple to
Postgres internals. → **explicit service-layer events**: each service calls `searchService.upsert(...)`
on create/update and `searchService.delete(...)` on soft-delete — the same explicit pattern as
AssetHistory ([[0033-asset-history-event-model]]).

**(3) Coupling — block on Meili vs fail-soft.** A search engine must never take the app down. →
**fire-and-forget with catch + log**: sync calls are not awaited into the request; failures are
logged (CRITICAL) and swallowed. If Meili is down, writes still succeed and search degrades.

## Decision

- **Meilisearch** as an external service: added to the dev `docker-compose.yml` (loopback `:7700`,
  `MEILI_MASTER_KEY`); **production is a DevOps hand-off** — add it to `infra/docker-compose.prod.yml`
  (this lane does not touch `infra/`). Config via `MEILI_HOST` / `MEILI_MASTER_KEY`
  ([[0028-secrets-and-config]]). If `MEILI_HOST` is unset the search wiring no-ops (search disabled).
- **Indexed entities**: `assets`, `articles`, `users`, `locations`, `applications` (one Meili index
  each; primary key `id`).
- **Sync**: `SearchService.upsert(index, doc)` / `delete(index, id)`, called **fire-and-forget** from
  each service's create / update / soft-delete. Soft-deleting removes the document, so soft-deleted
  rows never appear in results. A failed sync is logged, never thrown.
- **Endpoint**: `GET /search?q=&entities=assets,articles&limit=20` → `{ assets: { hits, total },
  articles: {...}, users: {...}, locations: {...}, applications: {...} }` (only the requested
  `entities`, or all when omitted), via Meilisearch `multiSearch`.
- **Bootstrap / recovery**: `bun run reindex:all` repopulates every index from the database (first
  run, and drift repair after Meili downtime).

## Consequences

- **Positive:** fast, typo-tolerant, unified search; the app is resilient to Meili being down
  (fail-soft); reindex repairs any drift.
- **Eventual consistency:** a dropped sync leaves the index stale until the next update or a
  `reindex:all` — acceptable, and observable via the error logs.
- **New operational dependency:** Meilisearch must run in every environment; the master key is a
  secret ([[0028-secrets-and-config]]). **DevOps owns the prod service + secret.**
- **No authorization on search yet** (no auth, [[0016-auth-strategy-deferred]]); results exclude
  soft-deleted rows but are otherwise unfiltered by caller.

## Deferred (explicit)

- Faceting / filtered search, relevance tuning, highlighting, incremental/batched reindex, and
  per-caller authorization (post-auth).

## Hand-offs

- **DevOps:** add `meilisearch` to `infra/docker-compose.prod.yml` (+ `MEILI_MASTER_KEY` secret,
  `MEILI_ENV=production`, never publish the port) and run `reindex:all` once on first deploy.
- **Frontend:** _delivered_ (#21) — a ⌘K command palette in the topbar consuming `GET /search`
  (`apps/web/components/global-search.tsx`); the response is typed in `@lazyit/shared` (`search`
  schema). Results group by entity and degrade gracefully where no detail page exists yet.

Related: [[asset]] · [[article]] · [[user]] · [[location]] · [[application]] ·
[[0031-logging-strategy]] · [[0032-soft-delete-middleware]] · [[0028-secrets-and-config]] ·
[[0016-auth-strategy-deferred]]
