# Backend performance & optimization

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Backend**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The backend is correct and N+1-free, but unbounded list endpoints (SEC-007/ADR-0030 still unimplemented) plus over-fetching of full markdown bodies and the deep asset graph are the real scaling cliffs; a per-request auth DB lookup and missing partial deletedAt indexes are the next tier.

## Findings (10)

### 1. No pagination on any list endpoint → unbounded result sets and O(n) serialization

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | high | large | high |

- **Location:** `apps/api/src/{users,locations,asset-categories,asset-models}.service.ts findAll; assets.service.ts:56; access-grants.service.ts:57; articles.service.ts:75; consumables.service.ts:43`
- **Why it matters:** ADR-0030 froze a PageQuery/Page<T> contract (default 50, max 200) but it is implemented NOWHERE — no pagination schema exists in @lazyit/shared. Every findMany is unbounded (the asset-history timeline is the lone exception, with a proper id cursor). Append-only tables (asset_assignments, access_grants, consumable_movements) never shrink, so payload and DB scan grow monotonically. The CEO's grow-into-a-large-platform mandate expires the deferral's MVP-scale premise. Same gap as SEC-007.
- **Recommendation:** Implement ADR-0030 now: define PageQuery/Page<T> in @lazyit/shared, cursor-first for the growing/append-only tables and offset for small reference lists, default take 50 / hard max 200. Migrate GET /access-grants (most sensitive) and GET /assets (heaviest) first. Split front/back per ADR-0020.

### 2. GET /assets eager-loads a deep relation graph for every row with no cap

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | high | medium | high |

- **Location:** `apps/api/src/assets/assets.service.ts:26-34 (ASSET_RELATIONS), :54-76 (findAll), :64-68 (q ILIKE)`
- **Why it matters:** ASSET_RELATIONS inlines model+category, location, and active assignments+each owner's full user row. It is NOT N+1 (fixed query count, correct), but findAll applies the full graph to ALL assets with no take and no select — returning every column incl. the specs jsonb blob plus full joined rows. The q filter is three ILIKE '%…%' predicates with no trigram index = sequential scan. This is the inventory pillar's main screen and the heaviest endpoint.
- **Recommendation:** Add pagination (#1); give the list a lean projection omitting specs and trimming joined user/model/location to rendered fields, keeping the full graph on findOne only (needs a shared-schema split — flag to CTO); route free-text q to Meili (already built) or add a pg_trgm GIN index.

### 3. GET /articles ships the full markdown content of every article in the list

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | high | small | high |

- **Location:** `apps/api/src/articles/articles.service.ts:75-78; packages/shared/src/schemas/article.ts:33-48 (content field)`
- **Why it matters:** findAll returns whole Article rows with no select, and ArticleSchema (the advertised response DTO) includes content: z.string() — the entire Markdown body (unbounded Postgres text). A list view needs only title/excerpt/status/slug/dates, so the largest text column in the schema is re-serialized for every article on every list load. The q filter also does un-indexed ILIKE on title/excerpt.
- **Recommendation:** Add a list-specific select that omits content (keep excerpt) or define a lean ArticleListItem schema in @lazyit/shared returned by findAll. Quick, high-value; coordinate the shared-schema split with the CTO. Pagination compounds the win.

### 4. Auth guard does a DB lookup on EVERY authenticated request with no user cache

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | medium | medium | high |

- **Location:** `apps/api/src/auth/jwt-auth.guard.ts:82 (shim), :157-159 (OIDC externalId lookup)`
- **Why it matters:** JwtAuthGuard is the global APP_GUARD, so it runs before every controller. In OIDC mode each request runs a findFirst by externalId to resolve the User — one DB round-trip per request for the same handful of users (externalId is @unique so it is indexed/fast, but still on the critical path of 100% of traffic). The JIT discovery/userinfo fetch correctly short-circuits for existing users (first-login only). For a 2-20-person team this is the clearest caching opportunity in the backend.
- **Recommendation:** PROPOSAL: add a small in-process TTL cache (Map<externalId,{user,exp}>, 30-60s, or @nestjs/cache-manager) keyed by sub, invalidated on user update/delete. Keep in-process (single-org/single-node, ADR-0015 — no Redis). Mind the soft-delete/isActive edge so a deactivated user loses access promptly. Needs CTO sign-off (security-sensitive).

### 5. No deletedAt index → soft-delete-aware reads pay a non-covered residual filter that degrades as dead rows accumulate

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | medium | small | medium |

- **Location:** `apps/api/prisma/schema.prisma (deletedAt on User:30, Asset:152, Article:297, etc.; no partial index anywhere)`
- **Why it matters:** The soft-delete extension adds deletedAt: null to every read on 9 models, but no @@index references deletedAt (all indexes cover FKs/status/slug). For id lookups the predicate is free; for list/filtered scans it is a residual filter, and since soft-deleted rows are never purged (ADR-0006 auditability) dead rows accumulate in the heap forever, degrading scan selectivity over time.
- **Recommendation:** Add raw-SQL partial indexes matching hot queries, e.g. CREATE INDEX … ON assets(status) WHERE deletedAt IS NULL, … ON articles(categoryId,status) WHERE deletedAt IS NULL. Prisma can't express partial indexes in PSL — follow the existing assignment partial-unique-index precedent in migration 20260526120000. Pair with pagination so the index backs a bounded query.

### 6. Soft-delete extension wraps every query in a $allOperations hook plus a per-request Proxy with re-binding

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | medium | medium | medium |

- **Location:** `apps/api/src/prisma/prisma.service.ts:31-55 (extension + Proxy); soft-delete.extension.ts:47-65`
- **Why it matters:** Two layers run on every model access: a Proxy get-trap (prop-in-ext lookup + a fresh .bind allocation per function access, not cached) and the $extends $allOperations hook that object-spreads args/where on every operation incl. non-soft-deletable models and writes. Correct and tested, but constant per-query JS overhead + GC pressure on 100% of DB calls, including the high-frequency auth-guard lookups.
- **Recommendation:** Low-urgency micro-opt: memoize bound methods/model delegates in the Proxy so repeated prisma.user/$transaction accesses don't re-bind. Do NOT remove the abstraction (ADR-0032). Treat as a profiling follow-up, not a now-fix.

### 7. CRUD mutations do a separate read-then-write round-trip purely for a 404

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | low | small | high |

- **Location:** `applications.service.ts:49; users.service.ts:40; locations.service.ts:40; asset-models.service.ts:44; consumables.service.ts:75; common/prisma-exception.filter.ts`
- **Why it matters:** The standard mutation shape is read-for-404 then write (two round-trips). Some pre-reads are load-bearing (assets update at :126 captures before-state for history diffing; the assignment duplicate-active pre-check at :79 is a friendly 409 backed by the partial unique index). But the pure existence pre-reads (findOne/assertExists before update/remove across applications/users/locations/models/categories/consumables) exist only to map P2025 to a clean 404 — which the existing PrismaExceptionFilter already does.
- **Recommendation:** Where the pre-read is only for a 404, rely on PrismaExceptionFilter's P2025→404 mapping and drop the extra read. Keep the assets update pre-read (history diffing) and the assignment duplicate check (UX). Cleanup, not hot path — defer behind #1-#3.

### 8. Fire-and-forget Meili sync is per-document with no batching or backpressure

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | low | small | high |

- **Location:** `apps/api/src/search/search.service.ts:77-105; call sites across assets/articles/applications/users/locations services`
- **Why it matters:** Each create/update/delete fires one un-awaited single-doc addDocuments/deleteDocument to Meili (ADR-0035 fire-and-forget, fail-soft, no-op when disabled) — the right correctness design. But there is no batching and no bounded queue: a future bulk import would fan out N individual un-awaited HTTP calls with no backpressure, and a missed upsert leaves the index stale until reindex-all runs (no retry).
- **Recommendation:** Fine as-is now. When bulk import/export lands (a stated gap), route its sync through Meili's batch addDocuments (already accepts arrays) and consider a tiny micro-batch (flush every ~100ms or N docs). Defer a durable queue (BullMQ/Redis) per the Bun-scope ADR note.

### 9. Prisma adapter-pg pool is fully default — no explicit size/timeouts, undocumented

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | low | quick-win | medium |

- **Location:** `apps/api/src/prisma/prisma.service.ts:24-29`
- **Why it matters:** PrismaPg is constructed with only a connectionString — no max pool size, no connection/idle timeouts (pg default max is 10), and no statement_timeout/transactionOptions anywhere. Reasonable defaults for single-node single-org (ADR-0015), but implicit and undocumented, conflicting with the IT-generalist-operator / loud-actionable-config mandate. Combined with unbounded lists, a heavy GET /assets can hold a connection for a full scan with no ceiling.
- **Recommendation:** Make pool size env-tunable (PrismaPg({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) })) and set a statement_timeout + Prisma transactionOptions as a safety net once pagination lands. Document in .env.example + deployment runbook (coordinate with DevOps lane).

### 10. Low-stock consumable filter uses a column-to-column comparison that can't use a conventional index

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | low | small | medium |

- **Location:** `apps/api/src/consumables/consumables.service.ts:42-52; schema.prisma:435`
- **Why it matters:** currentStock is a well-designed transactionally-maintained cache (ADR-0034) updated inside the movement $transaction with a negative-stock guard — a net win that avoids SUMming the ledger on every read. The one weak spot: the lowStock filter compares two columns (currentStock <= minStock via a Prisma field reference), which Postgres can't satisfy with a single-column index — it is a sequential scan. Fine for a small parts catalog.
- **Recommendation:** Keep the cache. If low-stock listing ever gets slow, add a partial/expression index (WHERE currentStock <= minStock, raw SQL) or a maintained belowReorder boolean. Defer until the catalog is large.

## Quick wins

- Lean GET /articles projection: add a select omitting the full markdown content (keep excerpt), or a shared ArticleListItem schema — kills the largest wasteful payload in the app (articles.service.ts:75 + article.ts:37).
- Make the Prisma adapter-pg pool explicit and env-tunable (max + timeouts) and document it in .env.example + the deployment runbook (prisma.service.ts:24-29).
- Add raw-SQL partial indexes WHERE deletedAt IS NULL on the hot lists (assets by status, articles by categoryId/status), following the existing assignment partial-index migration precedent.
- Drop the existence-only pre-reads before update/remove on the simple CRUD services and lean on PrismaExceptionFilter's P2025→404 mapping — halves write round-trips (applications/users/locations/models/categories/consumables).

---

## Round 1 implementation (CTO proposal)

> Landed on branch `perf/list-pagination` (issue #69). Addresses findings **#1, #2, #3** — the
> three highest-priority items. No `schema.prisma`/migration change; DB indexes (#5) are **deferred
> to Round 2**.

**Shared contract (ADR-0030).** `packages/shared/src/schemas/pagination.ts` now defines the
offset-pagination contract once: `PageQuerySchema` accepts either `{ limit, offset }` or
`{ page, limit }` and **normalizes** to a canonical `{ limit, offset }` (offset wins if both are
given); `limit` defaults to **50** and is **hard-capped at 200 — a larger value is rejected (400),
never silently clamped**. A generic `Page<T>` envelope (`{ items, total, limit, offset }`) via the
`pageSchema(item)` factory + `PageMetaSchema`, plus helpers `offsetOf(query) -> { take, skip }` and
`pageOf(items, total, query) -> Page<T>`. Unit-tested in `pagination.test.ts` (`bun test`).

**Lean list schemas.** `ArticleListItem` (= `ArticleSchema` **minus `content`**, `excerpt` kept) and
a lean `AssetListItem` (omits the `specs` jsonb; trims `model`+`category`/`location`/active-owner
joins to the fields the table renders) + their `Page` wrappers, plus an `AccessGrantListPage`
envelope. All additive to the barrel.

**Paginated endpoints.** `GET /access-grants` (most sensitive), `GET /assets` (heaviest) and
`GET /articles` each gained a service `findPage(filters, page, currentUser?)` that runs
`findMany(take/skip)` + `count` over the **same `where` inside one `$transaction`** (count can't
drift from the page). The unpaginated `findAll` stays on `AccessGrantsService` for the
inherently-scoped nested lists (`/users/:id/access-grants`, `/applications/:id/access-grants`); the
asset/article `findAll` had no other caller and was replaced by `findPage`. Controllers parse the
pagination query via a reusable `apps/api/src/common/parse-page-query.ts` (bad pagination → 400) and
keep using `@CurrentUser()`.

**Lean projections.** `GET /articles` no longer ships the markdown `content` per row (lean `select`,
`excerpt` kept); `GET /assets` list uses a lean `select` (no `specs`, trimmed joins) while
`findOne` keeps the full relation graph incl. `specs`.

**Deferred to Round 2 (DB indexes, finding #5).** Recommended raw-SQL **partial indexes** matching
the now-bounded hot lists, following the assignment partial-unique-index precedent (migration
`20260526120000`):
- `assets (status) WHERE deletedAt IS NULL` and `assets (createdAt) WHERE deletedAt IS NULL` (the
  list orders by `createdAt desc`); consider `assets (locationId) WHERE deletedAt IS NULL`.
- `articles (categoryId, status) WHERE deletedAt IS NULL` and an `articles (updatedAt)` index (the
  list orders by `updatedAt desc`).
- `access_grants (grantedAt)` to back the `ORDER BY grantedAt DESC` + a partial index on
  `(revokedAt)` for the active-only filter.
- The free-text `q` filter is still un-indexed `ILIKE '%…%'` — route to Meili (already built) or add
  a `pg_trgm` GIN index (also Round 2 / search lane).

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
