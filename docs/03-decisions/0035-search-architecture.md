---
title: "ADR-0035: Cross-cutting search architecture (Meilisearch)"
tags: [adr]
status: accepted
created: 2026-05-26
updated: 2026-10-03
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
- **Indexed entities**: `assets`, `articles`, `users`, `locations`, `applications`, `infra` (one Meili
  index each; primary key `id`). The `articles` document includes the markdown **`content`** since
  [[0042-article-versioning-and-linking]] (runbook bodies are findable); only PUBLISHED articles are
  ever indexed, so a DRAFT's content can't leak. The `infra` index ([[0070-infra-topology-graph]] v1)
  carries each topology node's `label`, `kind`, `status`, `state`, `ipAddress` and the linked Asset's
  `assetName`; `kind`/`status`/`state` are **filterable** (the canvas/Servers-list filters). It NEVER
  indexes secret values (a node holds none — zero-knowledge, [[0061-secret-manager-zero-knowledge]]).
  Soft-deleted nodes are off the map and excluded. Re-run `reindex:all` after deploy to backfill it.
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

## Amendment (2026-09-26) — client/server version policy, server upgrade, wire test (issue #1216)

**Status: accepted — decided by the CEO 2026-09-26 ("new index + automatic reindex").** Until now the
Meilisearch **server** (`getmeili/meilisearch:v1.12.3`) and the **client** (`meilisearch` npm, 0.60)
drifted independently — the client's own CI had moved to server v1.50+ — and nothing in this repo made a
real wire call (every search spec mocks the client), so a client/server break would have surfaced only
as an operator's empty search. This amendment fixes the pair, states the policy, and makes it checkable.

### What changed

- **Server `v1.12.3` → `v1.53.2`** (community edition, `getmeili/meilisearch`, MIT-licensed; digest-
  pinned in `compose.yaml`). **Client `^0.60.0` → `^0.62.0`** — this supersedes Dependabot PR #1302.
  Client 0.62.0's CI (`.github/workflows/tests.yml` at tag `v0.62.0`) runs against Meilisearch v1.53.
- **Nothing in our settings needed to change.** The routes we use — `createIndex`, `addDocuments`,
  `deleteDocument`, `updateFilterableAttributes` (plain string-array form), `swapIndexes` (we still omit
  the optional `rename`, default `false`), `deleteIndex`, `getStats().indexes[*].numberOfDocuments`,
  `multiSearch` with `attributesToRetrieve` + `filter`, `/health` — behave identically on v1.53.2; the
  breaking changes between v1.12 and v1.53 are in areas we do not use (embedders / `_vectors`, experimental
  features, chat). `MEILI_MASTER_KEY`, `MEILI_ENV` and `MEILI_NO_ANALYTICS` are unchanged. The wire test
  below is the evidence, not this paragraph.
- **New data volume, automatic rebuild.** A Meilisearch database only opens on the **exact** engine
  version that wrote it (major.minor.patch; `--upgrade-db` exists since v1.51 but cannot open pre-v1.12
  data and is one-way). The index is derived data, so we do not migrate it: the compose volume is renamed
  `meili_data` → **`meili_data_v1_53_2`**, the engine starts empty, and the existing boot self-heal
  (2026-06-11 amendment) rebuilds **every** index from Postgres in the background. The self-heal now
  first **waits for the engine to answer `/health`** (bounded: 30 × 10 s) before probing, because there is
  no api → meilisearch `depends_on` and a one-shot probe against a still-starting engine would otherwise
  give up until the hourly reconcile sweeper. Readiness (`/health/ready`) still gates on Postgres only, so
  the rebuild never delays boot or trips the update health gate; search returns partial results (never an
  error) for the few minutes the rebuild takes.
- **The old volume is never deleted by us.** It stays on disk (compose never removes an undeclared
  volume); a rollback to an earlier tag mounts it again and finds its v1.12 data intact. `start.sh` and
  `update.sh` **print** a one-line hint with the exact `docker volume rm` command when they see it —
  print-only, never delete.

### The version policy (judge every future bump against this)

1. **The server is the Meilisearch version the pinned client is tested against.** Look up the client
   release's CI (`meilisearch-js` `.github/workflows/tests.yml` at the release tag) — it names the server
   minor. Pin that minor's **latest patch**, community image, **by digest**.
2. **Client and server move together, in one PR.** A Dependabot client bump is mergeable on its own
   only when the new client's CI still targets our server minor **and** the `search-wire` CI job is
   green. If the new client targets a newer server minor, the bump waits for (or becomes) a server-upgrade
   PR under rule 3 — it is not merged alone.
3. **Every server bump — patch included — renames the data volume** to `meili_data_v<major>_<minor>_<patch>`
   and updates the old-volume hint in `infra/start.sh` / `infra/update.sh`. CI enforces the name (the
   `search-wire` job fails when the volume does not encode the pinned version); forgetting it would
   crash-loop Meilisearch on every existing instance. The rebuild is automatic (self-heal); the release
   notes tell operators search is partial for a few minutes and how to remove the previous volume.
4. **The wire test is the arbiter.** `apps/api/test/search.wire.spec.ts` (`bun run test:wire` in
   `apps/api`, not part of the default unit run) runs in the `search-wire` CI job against the service
   **started from `compose.yaml`** — the same pin, no second copy to drift. It covers the fresh-engine
   self-heal, the real filterable-attribute settings, every document projector, the article folder
   filter (including the fail-closed never-match expression), `upsert`/`remove`, and the swap rebuild.
   A client or server change that fails it is not mergeable, whatever the changelog says.

## Amendment (2026-10-03) — purchases and suppliers, gated per caller (issue #1499)

**Status: accepted (technical, within this ADR's direction and ADR-0099's D-A).** Two new indexes,
`purchases` and `suppliers` ([[0099-purchases-scope-model-and-optionality]] §13 listed purchases in global
search as not built). Nine indexes in all.

- **Projections — display fields, plus searchable-only text.** A purchase document carries `reference`,
  `supplierName` (the supplier joined, even when archived — the purchase page still shows it),
  `invoiceNumbers`, the **stored** `status` (the received states are derived on read, ADR-0099 §3, and not
  indexed), `orderDate` and `createdAt` as ISO strings (the palette titles a purchase the way the list does),
  and `lineDescriptions` — the live lines' descriptions, so a purchase is found by what it bought. A supplier
  document carries `name`, `taxId`, `salesContactName` and `supportContactName`. **Never indexed:** money,
  notes, company, delivery location; supplier emails, phones, website and notes. **Never retrieved**
  (searchable only, the SEC-061 pattern): `lineDescriptions` and the two contact names. The hit contract is
  `PurchaseHitSchema` / `SupplierHitSchema` in `@lazyit/shared`.
- **Authorization — at the result level, like `users`.** `search:read` still gates the endpoint; the
  controller additionally drops `purchases` and `suppliers` from the requested indexes unless the
  principal holds `purchaseOrder:read` ([[INVARIANTS]] INV-PO-1). The check is per **principal**
  (`PermissionResolverService.principalHas`), so a service account needs the direct grant. A dropped index
  is never queried: no hit and no count reach the caller. The `lazyit_search` AI tool runs through the same
  controller, so it inherits the gate. The web hides the two filter chips without the permission.
- **Sync — re-read on commit.** A purchase document joins rows its service does not hold after a line edit
  or a supplier rename, so instead of each call site projecting a document, `PurchaseSearchSync` (in the
  search module) is told *which* record changed, after the transaction commits, and re-reads it: live →
  upsert, archived or missing → remove. Called from purchase create / update / archive / restore, line
  add / update / remove, *create from assets*, and supplier create / update / archive / restore. A supplier
  sync also re-projects that supplier's live purchases in one batched upsert (`SearchService.upsertMany`),
  so a rename reaches `supplierName`. Receiving, linking and cancelling units change nothing indexed and do
  not sync. Still fire-and-forget and fail-soft (§3); the reconcile sweeper repairs a dropped write.
  **Supplier merge (#1496) must call `PurchaseSearchSync.supplier` for the surviving and the merged
  supplier** once its transaction commits.
- **Upgrade — no step.** On an existing instance the two indexes do not exist yet, so the boot self-heal
  (2026-06-11 amendment) sees them as missing and builds them in the background from Postgres on the first
  start after the update; the seven existing indexes have documents and are left alone. `reindex:all` and
  the reconcile sweeper cover both indexes too. Not a server bump: no volume rename.
- **Cost.** An instance with no purchases (or no suppliers) keeps an empty index, which the self-heal
  rebuilds — cheaply, to empty — on every boot, as for any other empty index. A supplier edit re-projects
  all of its purchases, which is fine at small-team sizes and one engine task, but grows with the supplier's
  purchase count.

## Deferred (explicit)

- Faceting / filtered search, relevance tuning, highlighting, incremental/batched reindex, and
  per-caller authorization (post-auth).

## Hand-offs

- **DevOps:** _delivered_ — `meilisearch` is in the canonical `compose.yaml` (+ `MEILI_MASTER_KEY`
  secret, `MEILI_ENV=production`, port never published under `--profile prod`). First deploy needs no
  manual reindex any more — the boot self-heal fills empty indexes; `reindex:all` stays the manual full
  repair. Server/client pins follow the 2026-09-26 version policy above. (The old `infra/docker-compose.prod.yml` target was consolidated — §9 above.)
- **Frontend:** _delivered_ (#21) — a ⌘K command palette in the topbar consuming `GET /search`
  (`apps/web/components/global-search.tsx`); the response is typed in `@lazyit/shared` (`search`
  schema). Results group by entity and degrade gracefully where no detail page exists yet.

Related: #383 · #1216 · #1499 · [[asset]] · [[article]] · [[user]] · [[location]] · [[application]] ·
[[0031-logging-strategy]] · [[0032-soft-delete-middleware]] · [[0028-secrets-and-config]] ·
[[0016-auth-strategy-deferred]] · [[0056-in-app-notification-bell]] (the retention sweeper this
amendment's reconcile sweeper mirrors)
