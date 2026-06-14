---
title: "ADR-0035: Cross-cutting search architecture (Meilisearch)"
tags: [adr]
status: accepted
created: 2026-05-26
updated: 2026-06-11
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

- **Meilisearch** as an external service: a service in the canonical root `compose.yaml` (unprofiled
  backing service; `compose.override.yaml` publishes loopback `:7700` for dev, `--profile prod` keeps
  it internal-only). _Originally hand-off to DevOps for `infra/docker-compose.prod.yml`; that file was
  since consolidated into `compose.yaml` — see [[auth-zitadel-sot]] §9._ Config via `MEILI_HOST` / `MEILI_MASTER_KEY`
  ([[0028-secrets-and-config]]). If `MEILI_HOST` is unset the search wiring no-ops (search disabled).
- **Indexed entities**: `assets`, `articles`, `users`, `locations`, `applications` (one Meili index
  each; primary key `id`). The `articles` document includes the markdown **`content`** since
  [[0042-article-versioning-and-linking]] (runbook bodies are findable); only PUBLISHED articles are
  ever indexed, so a DRAFT's content can't leak. Re-run `reindex:all` after deploy to backfill it.
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
  `reindex:all` — acceptable, and observable via the error logs (the `upsert`/`remove` `.catch`
  logs at ERROR with `{ index, id, op }`, amendment 2026-06-11).
- **New operational dependency:** Meilisearch must run in every environment; the master key is a
  secret ([[0028-secrets-and-config]]). **DevOps owns the prod service + secret.**
- **No authorization on search yet** (no auth, [[0016-auth-strategy-deferred]]); results exclude
  soft-deleted rows but are otherwise unfiltered by caller.

## Amendment (2026-06-11) — degraded signal + boot self-heal (issue #370)

The original fail-soft posture made an **outage indistinguishable from an empty result** (any Meili
read failure returned an empty `{ hits, total }` 200, which the palette rendered as "Sin resultados"),
and a **freshly-seeded DB left every index empty** (the seed never indexes; `reindex:all` is manual),
so search silently returned nothing until someone reindexed by hand. Two targeted changes, no posture
change:

- **`degraded` flag (shared contract).** `SearchResultsSchema` (@lazyit/shared) gains an optional
  `degraded: boolean` (default `false`). The endpoint stays fail-soft — on a `multiSearch` rejection it
  still returns empty blocks with HTTP 200 — **but** sets `degraded: true`. The ⌘K palette
  (`global-search.tsx`) renders the existing error `StatusRow` ("search unavailable") when `degraded`,
  so a transient outage no longer masquerades as a genuine empty result. A healthy response omits the
  flag.
- **Boot self-heal (`SearchBootstrapService`).** `onApplicationBootstrap` asks Meili for per-index doc
  counts (`getStats`) and, for any **missing or empty** index, kicks off a **background, un-awaited**
  rebuild reusing the zero-downtime `reindexIndex` swap. It **never blocks boot/readiness** and is a
  strict **no-op when every index already has documents** — so it is safe on a large prod DB (it only
  ever fires when there is nothing to lose) and disabled under `NODE_ENV=test` / search-disabled mode.
  This makes the manual-reindex step self-healing for a fresh DB without removing it as a recovery tool.

Still **out of scope (follow-up):** full incremental-sync reconciliation for a dropped fire-and-forget
write while the DB stays up (i.e. a row whose `upsert`/`remove` was dropped and which is not empty
enough to trigger the boot self-heal). For now the dropped write is at least **diagnosable** — the
`.catch` logs at ERROR with `{ index, id, op }` — and repairable via `reindex:all`. Pinning explicit
index settings (`searchableAttributes` / typo tolerance) remains an open question (engine defaults kept).

## Amendment (2026-06-14) — periodic drift-reconcile sweeper (issue #383)

**Status: accepted (technical, within this ADR's direction).** This closes the "still out of scope
(follow-up)" gap the 2026-06-11 amendment named: a Meili `upsert`/`remove` that is **dropped while the
DB stays up** (fire-and-forget fail-soft, decision §3 / option 3) leaves the index **silently drifted**
from the DB — a row that exists-but-isn't-indexed, or is-indexed-but-was-deleted — and the boot
self-heal only catches a **wholly empty/missing** index, never a *partially* stale one. Until now the
only repair for that partial drift was the **manual** `reindex:all`. This amendment adds an automatic,
periodic **drift-reconcile sweeper** that runs while the app is up. **No posture change** — sync stays
fire-and-forget fail-soft; this is a background self-heal, not a write-path gate.

- **Pattern — an `unref`'d `setInterval`, mirroring the notification retention sweeper.** The reconcile
  sweeper is structured **exactly like** [[0056-in-app-notification-bell]]'s
  `apps/api/src/notifications/notifications-retention.sweeper.ts`: a plain `setInterval` (no
  `@nestjs/schedule` dependency), **`unref`'d** so it never holds the event loop / process open, a
  **re-entrancy guard** so a slow pass never overlaps the next tick, the **whole pass try/caught** so a
  transient Meili/DB error never crashes the API (fail-soft), and **not started under `NODE_ENV=test`**
  (and a no-op in search-disabled mode, no `MEILI_HOST` — same gates as `SearchBootstrapService`).
- **Mechanism — REUSE the existing reindex service, do NOT duplicate reindex logic.** The sweeper does
  **not** re-implement projection or index-swap; it **reuses** the existing zero-downtime rebuild path —
  the same `SearchService.rebuildIndex` → **`reindexIndex`** swap that `reindex:all` and the boot
  self-heal ([[0035]]'s 2026-06-11 amendment, `SearchBootstrapService`) already use, over the same live
  document set (soft-deleted excluded; only PUBLISHED articles — draft privacy, ADR-0022/0035). A
  reconcile pass loads the live DB set for an index and rebuilds it through that existing seam, so a
  dropped `upsert`/`remove` is reconciled the next pass. (Reusing the full rebuild keeps the sweeper
  simple and correct; a true *incremental* diff — comparing per-id DB↔Meili to touch only the drifted
  rows — remains a possible future optimization, but is not needed at 5–20-person estate sizes.)
- **Configurable cadence — `SEARCH_RECONCILE_INTERVAL_MS` (default: hourly).** The interval is read from
  the env var **`SEARCH_RECONCILE_INTERVAL_MS`** ([[0028-secrets-and-config]]), defaulting to **one hour**
  (`60 * 60 * 1000`), matching the retention sweeper's "hourly is ample for a low-volume feed" cadence.
  An operator can tune it down for a busy install or up to reduce load.
- **Complements, not replaces, `reindex:all`.** The post-deploy operational **`reindex:all`** step
  (decision §"Bootstrap / recovery"; Hand-offs) **stays** — it is still the first-deploy backfill and the
  big-hammer recovery after a long Meili outage. The sweeper handles the *ongoing* drift-from-dropped-
  writes case automatically between deploys; the manual reindex remains the deterministic full repair.

This makes the §3 fire-and-forget trade-off **self-healing on a timer** without changing the fail-soft
write posture, mirroring the boot self-heal's "safe, background, never blocks" discipline — now extended
from *empty index* to *drifted index*.

## Deferred (explicit)

- Faceting / filtered search, relevance tuning, highlighting, incremental/batched reindex, and
  per-caller authorization (post-auth).

## Hand-offs

- **DevOps:** _delivered_ — `meilisearch` is in the canonical `compose.yaml` (+ `MEILI_MASTER_KEY`
  secret, `MEILI_ENV=production`, port never published under `--profile prod`); run `reindex:all`
  once on first deploy. (The old `infra/docker-compose.prod.yml` target was consolidated — §9 above.)
- **Frontend:** _delivered_ (#21) — a ⌘K command palette in the topbar consuming `GET /search`
  (`apps/web/components/global-search.tsx`); the response is typed in `@lazyit/shared` (`search`
  schema). Results group by entity and degrade gracefully where no detail page exists yet.

Related: #383 · [[asset]] · [[article]] · [[user]] · [[location]] · [[application]] ·
[[0031-logging-strategy]] · [[0032-soft-delete-middleware]] · [[0028-secrets-and-config]] ·
[[0016-auth-strategy-deferred]] · [[0056-in-app-notification-bell]] (the retention sweeper this
amendment's reconcile sweeper mirrors)
