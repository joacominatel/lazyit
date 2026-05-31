# Backend — Search Subsystem (Meilisearch) — Analysis
> as of 2026-05-30 (status_may_2026)

## Role & scope

Senior Search Engineer, read-only audit of the Meilisearch integration end-to-end:
data-exposure / authorization (does search leak DRAFT KB articles, soft-deleted rows, or
access-grant data?), sync correctness on create/update/delete/soft-delete, the reindex/recovery
story, fail-soft behavior, relevance/typo configuration, and the prod-compose gap. This is both a
feature-completeness and a potential data-exposure pass. I changed no code.

## Method

Read every file under `apps/api/src/search/**` (service, documents, controller, module, and the
three specs), the standalone reindex script `apps/api/scripts/reindex-all.ts`, and the
fire-and-forget sync call sites in the five feature services
(`assets`, `articles`, `users`, `locations`, `applications`). Cross-read the auth guard
(`apps/api/src/auth/jwt-auth.guard.ts`) to confirm `/search` is authenticated, the global-search
frontend (`apps/web/components/global-search.tsx`), ADR-0035, both compose files
(`docker-compose.yml`, `infra/docker-compose.prod.yml`), the env examples
(`apps/api/.env.example`, `.env.example`, `infra/env/.env.prod.example`), and the CTO system-map
search section. I grep-verified that **no index settings (searchable attributes, typo tolerance,
filterable attributes, ranking rules) are configured anywhere** in the repo, and that the reindex
script is **additive-only** (no `deleteAllDocuments` / index swap).

---

## Findings

### 1. `/search` returns soft-deleted and DRAFT data after any dropped sync — and the only "repair" tool can't repair it

- **Category:** bug · **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `apps/api/scripts/reindex-all.ts:50-66` (additive-only); the fail-soft sync contract
  `apps/api/src/search/search.service.ts:77-105`; ADR-0035 lines 53-54, 60-61.
- **Observation (FACT):** Sync is deliberately eventually-consistent and fail-soft — a `remove(...)`
  call that fails (Meili down, network blip) is caught and logged, never retried
  (`search.service.ts:94-105`). ADR-0035 says the recovery path for any such drift is
  `bun run reindex:all` ("drift repair after Meili downtime", ADR-0035:54,60-61). But
  `reindex-all.ts` only calls `meili.index(...).addDocuments(...)` (lines 50-66). `addDocuments`
  is an **upsert by primary key**; it never deletes documents that exist in the index but no longer
  exist (or are now soft-deleted / unpublished) in the DB. There is **no `deleteAllDocuments`, no
  index swap, no diff** (grep-confirmed). So a soft-deleted asset/user/location/application, or an
  unpublished/deleted article, whose `remove()` was dropped stays a **ghost document forever** —
  reindex does not evict it.
- **Why it matters:** This violates the core auditability/soft-delete principle (deleted domain data
  must not surface) and ADR-0035's own promise that "soft-deleted rows never appear in results."
  For users and applications it is a **data-exposure / privacy regression**: a deactivated employee
  (PII: full name + email, `search.documents.ts:74-81`) or a decommissioned application keeps
  showing up in the ⌘K palette that every authenticated user can open. The documented remediation
  (`reindex:all`) gives operators false confidence — they will run it and the ghosts remain.
- **Recommendation:** Make `reindex:all` authoritative: for each index, either
  `index.deleteAllDocuments()` then `addDocuments(...)`, or build a fresh index and
  `swapIndexes(...)` (zero-downtime, preferred). Document that reindex is a full rebuild. Separately,
  consider a periodic reconciliation (cheap: compare DB ids vs index ids per entity) so dropped
  removes self-heal without an operator. This is the single most important search finding.

### 2. Reads are NOT fail-soft — a Meili outage turns every `/search` into a 500

- **Category:** bug · **Severity:** medium · **Effort:** quick-win · **Confidence:** high
- **Location:** `apps/api/src/search/search.service.ts:112-139` (`search()`), `search.controller.ts:41-51`.
- **Observation (FACT):** Writes are wrapped in `.catch()` and never throw (lines 82-87, 99-104).
  But `search()` does `const response = await this.client.multiSearch(params)` (line 123) with **no
  try/catch**. The controller awaits and returns it directly. If Meili is up at construction time
  (so `enabled` is true) but goes down, becomes unreachable, or rejects the master key at query
  time, `multiSearch` rejects and the request 500s. The disabled-mode path (no `MEILI_HOST`) is
  handled, but the "configured but currently unhealthy" path is not. ADR-0035's stated principle is
  "a search engine must never take the app down" (line 35) — that holds for writes, not reads.
- **Why it matters:** The product mandate is "works offline / fail-soft / the app is resilient to
  Meili being down." Search should degrade to *empty results + a logged error*, not a 500 that the
  frontend surfaces as "Couldn't run the search" (`global-search.tsx:161-167`). The dev fail-soft
  story is asymmetric and surprising.
- **Recommendation:** Wrap the `multiSearch` await in try/catch; on failure log (error) and return
  `this.emptyResults(requested)`, exactly like disabled mode. ~10 lines. Add a spec asserting a
  rejected `multiSearch` resolves to empty blocks.

### 3. No Meili index settings — typo tolerance / searchable attributes / ranking are all defaults

- **Category:** feature · **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** Whole subsystem — grep across `apps/api` found **zero** calls to
  `updateSettings` / `searchableAttributes` / `typoTolerance` / `filterableAttributes` /
  `rankingRules` / `distinctAttribute`. Indexes are created implicitly by first `addDocuments`
  (`search.service.ts:80-81`, `reindex-all.ts:51-66`).
- **Observation (FACT):** Every index runs on Meili defaults. Defaults give typo tolerance and a
  reasonable ranking, so search *works*, but: (a) **no `searchableAttributes` ordering** — `id`
  (a `cuid`/`uuid`) is searchable by default, so an id-fragment match ranks oddly, and there's no
  boost of `name`/`title` over `notes`/`description`; (b) **no `filterableAttributes`** — the
  prerequisite for any future authorization filter (finding 4) and for faceted search (ADR-0035
  "Deferred"); (c) typo tolerance default applies even to short codes like asset tags/serials where
  exact matching is usually wanted.
- **Why it matters:** ADR-0035's headline justification over Postgres FTS is "typo-tolerant,
  ranked, fast." Without configured searchable attributes and ranking, relevance is whatever Meili
  guesses field-order to be — fine for a demo, weak for the "ServiceNow-grade" positioning, and it
  leaves no hook for the deferred authorization filtering the ADR anticipates.
- **Recommendation:** Add a one-time `applySettings()` (run in `reindex:all` and/or on boot) that
  sets per-index `searchableAttributes`, `displayedAttributes`, and `filterableAttributes`. Consider
  disabling typo tolerance on code-like fields. This is the natural home for the authZ groundwork.

### 4. Search has zero per-caller authorization — every authenticated user can search all users (PII), all applications, all locations

- **Category:** security · **Severity:** medium · **Effort:** large · **Confidence:** high
- **Location:** `search.service.ts:112-139` (no caller/user argument at all); `search.controller.ts`
  (no `@CurrentUser`); ADR-0035:64-65 ("No authorization on search yet … unfiltered by caller").
- **Observation (FACT):** `/search` is authenticated (the global `JwtAuthGuard`,
  `auth.module.ts:17`, applies — no `@Public` exemption, controller has none), but it applies **no
  authorization beyond authentication**. The article index already encodes the one domain rule that
  exists (DRAFTs are never indexed — `articles.service.ts:125-129,251-256`), so DRAFT KB leakage is
  correctly prevented at index time. But users, applications, and locations are indexed in full for
  anyone logged in. There is no access-grants index, so grant data itself is not searchable (good).
  The exposure is the "every authenticated user is equal" gap, surfaced through search: user PII
  (name+email) and the full application catalog are queryable by any account.
- **Why it matters:** For an IT tool holding sensitive Access data this matters more than for a
  generic app, and it compounds the missing-RBAC gap: when roles land, the REST layer can scope
  `GET /users` / `GET /applications`, but `/search` will silently bypass that scoping unless search
  is taught the same rules. This is the ADR-0035 deferral ("per-caller authorization (post-auth)") —
  auth has now landed (ADR-0038), so the precondition is met and the debt is live.
- **Recommendation:** PROPOSAL tied to the future RBAC model (do not build ahead of it). When roles
  land, plumb the current user into `search()` and either gate whole indexes by role or use Meili
  `filter` with per-document visibility attributes (needs `filterableAttributes` from finding 3).
  Until then, flag explicitly in the system-map that `/search` exposes the full
  user/application/location catalog to every account.

### 5. Doc drift — the CTO system-map says Meilisearch is missing from prod compose; it is present

- **Category:** docs · **Severity:** low · **Effort:** quick-win · **Confidence:** high
- **Location:** `.claude/skills/lazyit-cto/references/system-map.md:290` ("Not in prod compose
  (DevOps pending)") and `:305` ("Meilisearch missing from prod compose | Medium … Before first prod
  deploy"), vs `infra/docker-compose.prod.yml:157-174` (the `meilisearch` service IS defined,
  internal network, healthcheck, `meili_data` volume) and `infra/env/.env.prod.example:41-44`
  (`MEILI_HOST=http://meilisearch:7700`, key, `MEILI_ENV=production`).
- **Observation (FACT):** The "conflicting documentation" resolves cleanly: the DevOps hand-off from
  ADR-0035 was **completed**. Prod compose has Meili, the reindex bootstrap is documented inline
  (`docker-compose.prod.yml:160-161`), and the API↦Meili fail-soft means no `depends_on` is needed.
  ADR-0035 lines 41-43 and the Hand-offs block (72-75) still read as if it's pending; the system-map
  "Known debt" table still lists it as open Medium debt.
- **Why it matters:** A stale "Medium, before first prod deploy" blocker in the CTO's own debt
  register is misleading for release planning and erodes trust in the system-map.
- **Recommendation:** Update system-map lines 285/290/305 (Meili is in prod compose; debt closed)
  and amend ADR-0035 to mark the DevOps hand-off done. (Docs only — recorded here for the CTO.)

### 6. `reindex:all` uses `addDocuments` with no batching and no task-wait — silent partial failure on large datasets

- **Category:** infra · **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `apps/api/scripts/reindex-all.ts:38-74`.
- **Observation (FACT):** The script `findMany()`s every row of all five entities into memory at
  once (39-48) and pushes each entity in a single `addDocuments(...)`. It prints "Reindex *enqueued*"
  (68) and disconnects — it never awaits the Meili task or checks task status. At target scale
  (5-200-person company) memory is fine, but a single oversized payload can exceed Meili's default
  `http_payload_size_limit` and that entity's reindex fails; and because it exits on enqueue, an
  operator sees success even if indexing later errors.
- **Why it matters:** This is the recovery tool. An operator running it after Meili downtime needs it
  to be obviously correct or obviously failed — not "enqueued" then silently partial.
- **Recommendation:** Batch `addDocuments` (~1000/chunk) and `await client.waitForTask(taskUid)`
  before printing success; exit non-zero on any failed task. Pairs with the finding-1 rebuild rework.

### 7. Asset documents index free-text `notes` into a catalog every user can search

- **Category:** security · **Severity:** low · **Effort:** quick-win · **Confidence:** medium
- **Location:** `apps/api/src/search/search.documents.ts:53-62` (`projectAsset` includes `notes`).
- **Observation (FACT):** The asset document indexes `notes` (free-text). `specs` (jsonb) is
  correctly excluded. `notes` is searchable by every authenticated user. Whether that's a leak
  depends on what teams put there (warranty contacts, reminders, etc.).
- **Why it matters:** Same "every user is equal" exposure as finding 4, for a field whose content is
  operator-controlled and may be sensitive. Low because it mirrors what `GET /assets` already returns
  to any authenticated user; flagged so it's a conscious decision.
- **Recommendation:** Confirm with the CTO whether `notes` should be searchable. If not, drop it from
  `projectAsset` (one line) and it disappears on next sync/reindex.

### 8. The API authenticates to Meili with the **master key** (full admin), not a scoped search key

- **Category:** security · **Severity:** low · **Effort:** small · **Confidence:** high
- **Location:** `search.service.ts:56-59` (`apiKey: process.env.MEILI_MASTER_KEY`); reindex script
  `reindex-all.ts:36`; env wiring `infra/env/.env.prod.example:42`.
- **Observation (FACT):** Both the API runtime and the reindex script connect with
  `MEILI_MASTER_KEY` (full admin: create/delete indexes, rotate keys, read/write all). The API
  runtime only needs document write + search. `MEILI_ENV=production` is set (good — key auth
  enforced), and the engine is internal-network-only with no published port
  (`docker-compose.prod.yml:157-174`), which materially lowers the risk. The committed
  `infra/env/.env.prod` is **gitignored** (`git check-ignore` confirms it is NOT tracked), so the
  real-looking key in it is not in version control.
- **Why it matters:** Least-privilege (ADR-0028). If the API process is compromised, a master key
  hands full search-engine control to the attacker; a scoped key would not.
- **Recommendation:** PROPOSAL (DevOps lane): provision a scoped Meili API key (search +
  documents.add/delete on the five indexes) for the API runtime and reserve the master key for
  bootstrap/reindex. Low priority given the network isolation.

### 9. Articles are the only index with correct soft-delete + visibility sync — pattern is sound

- **Category:** code-quality · **Severity:** info · **Effort:** n/a · **Confidence:** high
- **Location:** `articles.service.ts:125-129,151,164,182,196,236-256`; reindex `reindex-all.ts:42-44`.
- **Observation (FACT):** Article sync is careful: create/import index only PUBLISHED (125-129,
  236-239); `update()` re-syncs via `syncSearch()` (upsert-if-PUBLISHED / remove-otherwise,
  251-256); `publish()` upserts (182); `unpublish()` removes (196); `remove()` (soft delete) removes
  (164); reindex filters `deletedAt:null, status:PUBLISHED` (42-44). DRAFT leakage is NOT a live bug
  at index time. The other four entities all correctly `remove()` on soft-delete (`assets:177`,
  `users:54`, `locations:54`, `applications:76`). The ONLY hole is the dropped-event /
  additive-reindex gap in finding 1.
- **Why it matters:** The visibility logic itself is sound; the risk is recovery, not steady-state.
- **Recommendation:** None for steady state. Ensure an article-service spec covers the
  publish→unpublish→search-removed transition (sync calls are fire-and-forget — assert on a mocked
  SearchService). Keep the `syncSearch` removes-on-DRAFT defensive behavior.

### 10. `entities` / `limit` parsing is robust; empty-query "browse" works — minor relevance note

- **Category:** code-quality · **Severity:** info · **Effort:** n/a · **Confidence:** high
- **Location:** `search.controller.ts:59-77` (`parseEntities`/`parseLimit`), `search.service.ts:112-138`.
- **Observation (FACT):** Input handling is good: unknown/duplicate entities dropped, order
  canonicalized, garbage falls back to all indexes, `limit` clamped 1-50 and truncated, NaN →
  default 20. Empty `q` is valid and returns top docs per index. The `multiSearch` result loop seeds
  empty blocks for every requested index so a missing per-index result is well-formed (125-137).
- **Why it matters:** Confirms the read path is well-built; no action.
- **Recommendation:** None. (Empty-`q` "browse top docs" ordering is Meili default ranking — another
  reason to configure `rankingRules`, finding 3.)

---

## Quick wins (≤ ~2 hours each)

1. **Make reads fail-soft (finding 2).** try/catch around `multiSearch`; return `emptyResults` on
   failure + log. ~10 lines + one spec. Removes a real "Meili down = 500" footgun.
2. **Fix the system-map / ADR-0035 doc drift (finding 5).** Meili IS in prod compose; close the
   "Medium, before first prod deploy" debt line and mark the ADR hand-off done.
3. **Decide on `notes` in the asset index (finding 7).** One-line keep/drop in `projectAsset`.

## Strategic recommendations (bigger bets, with sequencing)

1. **Authoritative reindex + reconciliation (finding 1, then 6).** First: rebuild semantics
   (`deleteAllDocuments`/swap) so `reindex:all` actually evicts ghosts; add batching + task-wait so
   it reports honest success. Then: a lightweight scheduled reconciliation (DB ids vs index ids) so
   dropped fire-and-forget removes self-heal — the durable answer to the eventual-consistency hole;
   land before lazyit scales past a single operator babysitting logs.
2. **Index settings layer (finding 3).** Per-index `searchableAttributes` / `displayedAttributes` /
   `filterableAttributes` / `rankingRules`, applied idempotently on boot and in reindex. Delivers the
   "ranked, typo-tolerant" promise properly and lays the `filterableAttributes` groundwork the authZ
   work needs.
3. **Search authorization, gated on RBAC (finding 4, depends on the roles model).** Do NOT build
   ahead of the (not-yet-existing) role model. Once roles land, plumb `@CurrentUser` into `search()`
   and filter by role/visibility — supersede the ADR-0035 deferral explicitly. Until then, document
   the full-catalog exposure as a known, accepted gap.
4. **Least-privilege Meili key (finding 8, DevOps).** Scoped API key for the runtime, master key for
   bootstrap only. Cheap defense-in-depth; sequence whenever DevOps next touches the search secret.

## Open questions for the CTO/CEO

1. **Recovery vs. real-time correctness:** is the eventual-consistency / fire-and-forget model
   acceptable for *security-relevant* eviction (soft-deleted users, decommissioned apps), or should
   removes be made reliable (outbox / retry) rather than relying on a reindex that today can't even
   evict them? (finding 1)
2. **Should `/search` expose the full user directory and application catalog to every authenticated
   account?** The missing-RBAC gap surfaced through search. Acceptable for now, or should search be
   the first place we introduce role gating? (finding 4)
3. **Is `asset.notes` appropriate to index into a globally-searchable catalog?** Depends on what
   teams actually store there. (finding 7)
4. **Owner of the index-settings layer:** is relevance tuning (searchable attributes / ranking) a
   backend-app concern or a DevOps/ops concern? It needs a home before it's built. (finding 3)

---

## Round 1 implementation (CTO proposal)

Branch `feat/search-hardening` — closes the two correctness/exposure findings that need **no schema
change** (findings 1 and 2; the honest-success part of finding 6 rides along). Findings 3, 4, 7, 8
remain deferred (they need index-settings/RBAC/DevOps work out of this round's scope).

### 1. Authoritative reindex — ghosts are now evicted (finding 1, + finding 6's task-wait)

- **What:** `scripts/reindex-all.ts` no longer does additive-only `addDocuments` (an upsert by
  primary key that could never delete). A new framework-agnostic helper
  `src/search/reindex.ts` (`reindexIndex`) rebuilds each index **authoritatively and zero-downtime**
  via the analyst-preferred swap path: ensure the live index exists (first-deploy safe) → build a
  fresh temp index from the live set in `REINDEX_BATCH_SIZE` (1000) batches, awaiting each Meili task
  → atomically `swapIndexes` the temp into place → drop the temp index. The script now calls it per
  index sequentially and prints "full rebuild — stale documents evicted".
- **Why:** the old additive reindex left soft-deleted **USER PII** and unpublished/deleted **DRAFT
  articles** searchable forever whenever a fire-and-forget `remove()` was dropped, and gave operators
  false confidence that `reindex:all` repaired drift. The swap makes the live index contain *exactly*
  the live set (every ghost evicted) without an empty/half-built window. The live set keeps the
  existing visibility filters — `deletedAt: null` for all five entities and `status: PUBLISHED` for
  articles — i.e. the same visibility the read path enforces.
- **Honesty (finding 6):** every task is awaited via `.waitTask()`; a failed Meili task now propagates
  and the script exits non-zero, instead of printing "enqueued" over a silently partial rebuild. The
  temp index is always disposed in a `finally`, so a failure never leaks it.

### 2. Fail-soft reads — a Meili outage no longer 500s `/search` (finding 2)

- **What:** `SearchService.search()` now wraps the `multiSearch` await in try/catch. On rejection it
  logs (`error`) and returns `emptyResults(requested)` — the exact same shape disabled mode returns.
- **Why:** writes were already fire-and-forget fail-soft (ADR-0035), but a configured-but-unhealthy
  engine (down after construction, or a revoked key) turned every read into a 500 the frontend
  surfaced as "Couldn't run the search". Reads now mirror the write-side posture: a search outage
  degrades search to empty results, it never takes the app down.

### Tests

- `src/search/reindex.spec.ts` (new): asserts the create-temp → add-to-temp → swap → drop-temp
  sequence, that documents only ever hit the temp index (the live index is replaced wholesale, so
  ghosts are evicted), empty-live-set still swaps, idempotent ensure when the live index already
  exists, `REINDEX_BATCH_SIZE` batching, and that a failed task propagates while the temp index is
  still disposed.
- `src/search/search.service.spec.ts` (extended): a rejected `multiSearch` resolves to empty blocks
  (not a throw) and is logged, for both an explicit entity subset and the all-five default.
- Verified: `tsc -p tsconfig.json --noEmit` clean; the four `src/search` Jest suites pass (37 tests).

### Out of scope / deferred

No schema or migration change. Index settings (finding 3), per-caller authorization (finding 4,
gated on RBAC), the `asset.notes` exposure decision (finding 7), a scoped Meili key (finding 8,
DevOps), and a scheduled DB-vs-index reconciliation (finding 1's durable follow-up) are untouched.
