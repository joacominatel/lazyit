---
title: "ADR-0042: Knowledge Base depth — append-only versioning + asset/application linking"
tags: [adr]
status: accepted
created: 2026-06-01
updated: 2026-06-05
deciders: [Joaquín Minatel]
---

# ADR-0042: Knowledge Base depth — append-only versioning + asset/application linking

## Status

accepted — 2026-06-01. Adds the first depth to the Knowledge Base on top of the MVP simple wiki
([[0021-knowledge-base-design]]), which explicitly deferred versioning. This ADR **walks back that
deferral** for versioning and adds article↔asset/application linking. It corrects a doc drift:
earlier notes claimed an [[article-version]] table already existed — it did not; this ADR is what
actually creates it, and the schema and docs now agree.

## Context

The CEO approved deepening the KB on 2026-06-01. Two gaps motivated it:

1. **Editing an article DESTROYS the prior content.** The MVP `update()` overwrites `content`/
   `title`/`excerpt` in place. That violates lazyit's **auditability-by-default** principle
   ([[0006-soft-delete-and-auditing]]): "what did this runbook say last quarter?" is unanswerable,
   and a bad edit silently loses the original body. The KB is the one pillar with no history at all
   (Assets have [[asset-history]], Access has the append-only [[access-grant]] ledger).
2. **The KB is not IT-native.** A runbook floats free of the infrastructure it documents. There is
   no way to say "this is the runbook for THIS server" or "the access procedure for THIS app", which
   is the whole point of an IT-team KB versus a generic wiki.

The MVP was deliberately designed so both are **non-destructive additions** ([[0021]] "Append-
improvable"): versioning = a new table with an FK from [[article]]; linking = a join table. No
reshaping of `Article`.

## CEO decision (verbatim)

> **KB depth = "Versionado + linking (Rec.)":** append-only ArticleVersion (snapshot on every edit)
> + article<->asset/application linking.

## Decision

### Append-only `ArticleVersion`

- A new **append-only** table ([[article-version]]) — `createdAt` only, **no `updatedAt`/
  `deletedAt`**, **autoincrement `id`** ([[0005-id-strategy]]) — exactly like [[asset-history]].
  Rows are never updated, deleted or soft-deleted.
- Columns: `articleId` (FK **Restrict** — an article with history can't be hard-deleted, mirroring
  AssetHistory), `version` (monotonic **per article**, `1` on create), a frozen copy of the editable
  state (`title`, `content`, `excerpt`, `status`), `editedById` (the actor, FK **SetNull**),
  `createdAt`. `@@unique([articleId, version])` is the natural key.
- **Snapshot on every write that changes a versioned field.** `create`/`import` write **version 1**;
  `update` snapshots when `title`/`content`/`excerpt` actually change (a metadata-only or no-op
  PATCH does **not**); `publish`/`unpublish` snapshot because they change `status`. Each snapshot is
  written **in the same `$transaction`** as the article write, so the version can never drift from
  the article it describes. `version` is allocated as `max(version)+1` inside that transaction; the
  `@@unique` is the hard guarantee against a concurrent double-allocation (the backend write path is
  effectively serial).
- Reads: `GET /articles/:id/versions` (paginated per [[0030-list-pagination-contract]], newest
  first) and `GET /articles/:id/versions/:version` (one). Both reuse the article read's visibility
  gate — a DRAFT's history is visible only to its author ([[0022-draft-visibility-auth-shim]]), so a
  private draft's snapshots never leak.
- **No rollback/restore-to-version endpoint** (deferred) — this ADR records history; replaying a
  past version onto the live article is a later wave.

### `ArticleLink` (article ↔ asset OR application)

- A new join table ([[article-link]]) — `cuid` id, `articleId`, nullable `assetId` and
  `applicationId`, `createdById` (FK SetNull), `createdAt`. **Not** soft-deletable and **not** an
  audit log: a link is current-state, created via `POST` and removed via `DELETE` (hard delete).
- **Exactly one target.** A DB **CHECK** (`(("assetId" IS NOT NULL)::int + ("applicationId" IS NOT
  NULL)::int) = 1`) is the hard guarantee; a zod `.refine` rejects the malformed body at the edge
  with a clean 400. FKs are `onDelete: Cascade` on all three (the link is meaningless without its
  endpoints and carries no audit value; articles/assets/apps normally soft-delete anyway).
- **No duplicate links.** Two **partial unique indexes** — `(articleId, assetId) WHERE assetId IS
  NOT NULL` and `(articleId, applicationId) WHERE applicationId IS NOT NULL` — because a single
  composite unique can't work (NULLs are distinct in Postgres). Raw SQL in the migration, mirroring
  the AssetAssignment / soft-delete-reuse precedent ([[0041-soft-delete-reuse-and-restore]]).
- Endpoints: `POST /articles/:id/links`, `DELETE /articles/:id/links/:linkId`, and `GET
  /articles/:id/links` (links are also includable when reading an article). Writes are author-only
  (same gate as edits) and `@Roles('ADMIN','MEMBER')` ([[0040-rbac-roles]]); the target must
  reference a **live** row (400 otherwise). The reverse `GET /assets/:id/articles` returns the
  **PUBLISHED** articles linked to an asset (lean list shape, no content).

### KB list affordances for the card UI (2026-06-03)

The KB card redesign needs the article list to (a) filter by whether an article is linked and (b)
show a reading-time + "linked" indicator per card — **without** loading the markdown body for the
whole page (the list is deliberately lean, content omitted — ADR-0030). Backend support (frontend is
a separate follow-up — #150):

- **`linked` / `linkedTo` filter on `GET /articles`.** `?linked=only` keeps only articles with ≥1
  `ArticleLink` (a relation `some` EXISTS predicate — no row multiplication, composes with the page +
  count); `?linkedTo=asset|application` narrows that to a single target kind. Both are **allowlisted**
  (the value sets live in `@lazyit/shared` `article-list.ts`); an unknown value is rejected with
  **400**, never silently ignored (consistent with ADR-0030). The filter is ANDed **on top of** the
  draft-visibility + soft-delete gate, so privacy is unchanged.

### KB list filters become multi-select (#198, 2026-06-05)

The KB list filters were single-choice (one status, one category, one link target). They are now
**multi-select** — the `status`, `categoryId` and `linkedTo` filters on `GET /articles` each accept
**several values that OR-combine within the filter** (union) and **AND-combine across filters**
(intersection). This follows the multi-value list-filter contract recorded in
[[0030-list-pagination-contract]] (amendment §8): each is a single **comma-encoded** query param
(`status=DRAFT,PUBLISHED`), the controller splits + validates **each element** against its allowlist
(unknown element → **400**), and a **single value still parses** (existing URLs / dashboard
deep-links unbroken).

- `status` → `status: { in: [...] }`; `categoryId` → `categoryId: { in: [...] }` in `buildWhere`.
- `linkedTo` is now multi-kind: a single kind narrows the link `some` predicate to that target
  column (`assetId`/`applicationId` `not null`); **both kinds** keep the unnarrowed `some: {}` (linked
  to an Asset OR an Application is exactly "has ≥1 link"). Any `linkedTo` still implies `linked=only`.
- This change covers the two target TYPES (`asset`, `application`) — reading (1) of "linked target".
  Picking *specific* linked entities (`assetId[]`/`applicationId[]` + an entity picker) — reading (2)
  — shipped as the follow-up **#213** (next subsection).
- **Frontend:** a reusable `MultiSelectFilter` (`apps/web/components/`, composing the vendored
  `DropdownMenu` + `DropdownMenuCheckboxItem` — no new primitive) backs each filter; selections are
  URL-synced (comma-encoded via `useListParams().setFilterValues`/`getFilterValues`) and shown as
  one removable chip per value in the active-filter bar, Activated-Restraint compliant (ADR-0049 —
  status hue rides a token `StatusDot`, never colored text).
- **`linkCount` per row.** The lean `select` adds a relation `_count` of `links`, flattened to a flat
  `linkCount` on the DTO — the card's "linked" indicator (`linkCount > 0`) with **no N+1**.
- **`readingMinutes` metric.** Rather than `length(content)` at read time (which would force loading
  the body or hand-writing raw SQL — and break the typed `findMany` + `_count` composition), a
  **maintained `Article.readingMinutes` column** (migration + one-time backfill) is recomputed on
  every write that touches `content` (create/import/edit) at ~200 words/min (min 1 for a non-empty
  body). The list reads it through the same typed lean `select` — no body load, and it is
  future-sortable via the ADR-0030 sort allowlist. The owner is already exposed as `authorId`.

### KB list filter by specific linked entities (#213, 2026-06-05)

Reading (2) of "linked target": where #198 filters by link **kind** (any Asset / any Application),
`GET /articles` now also filters by **specific** linked entities. Two new multi-value params —
**`assetId[]`** and **`applicationId[]`** — keep only the articles linked to ≥1 of *those exact*
assets / applications. Same multi-value wire contract as #198 ([[0030-list-pagination-contract]]
amendment): each is a single **comma-encoded** (or repeated) param, parsed by the controller with the
existing **`parseCuidArrayQuery`** (each element validated as a cuid — an unknown/garbage element →
**400**, never silently dropped), de-duplicated; a single value still parses.

- **Service `linkedWhere` composition.** Per kind the predicate is built independently — a specific
  selection (`assetId: { in: [...] }`) is **more granular than** the kind's `assetId: { not: null }`
  (#198), so it **wins within its kind** (a redundant `linkedTo=asset` alongside specific assetIds is
  ignored). The two kinds **OR-combine**: a single active kind is one `links: { some: <pred> }`; **both**
  kinds active with a specific narrowing is `OR: [{ links: { some: assetPred } }, { links: { some:
  appPred } }]` — an ArticleLink is asset XOR application (a row never carries both columns), so one
  `some` carrying both could never match; the OR-across-two-`some` shape is what "linked to one of these
  assets OR one of these apps" means. Selecting any specific entity **implies `linked=only`**. The
  legacy #198 fast path (both kinds via `linkedTo` only, no specific ids → the collapsed unnarrowed
  `some: {}`) is preserved. Soft-delete / `article:read` gating / draft-privacy (the visibility `where`
  is ANDed *on top*) are unchanged.
- **Shared.** `article-list.ts` gains `ArticleAssetIdFilterSchema` / `ArticleApplicationIdFilterSchema`
  (per-element `z.cuid()` allowlists), mirroring how #198 modeled the multi-value filter elements (the
  array shape + comma-split + 400-on-unknown live in the controller, not a zod `.array()`).
- **Frontend.** A reusable **`EntityMultiSelect`** (`apps/web/components/` — composes the same vendored
  Popover + cmdk Command as the #199 `Combobox`, **no new `ui/*` primitive**) backs a **searchable
  multi-select with checkmarks**: it keeps the popover open while toggling (the #198 pattern) and shows
  the first page on open (#218). Two thin wrappers feed it: **`AssetMultiSelect`** (server-search via the
  `q`-driven `useAssets` — no fleet ceiling) and **`ApplicationMultiSelect`** (client-filter over the
  small curated `useApplications` directory). Selections are URL-synced (comma-encoded via
  `useListParams().setFilterValues`/`getFilterValues`) and shown as one removable chip per id in the
  active-filter bar; each chip resolves its name **by id** (`useAsset`/`useApplication`) so a selection
  off the current search page still shows its label. The pickers appear under the existing **Linked-only**
  toggle (an additional, more granular control); toggling Linked-only off clears `linked` + `linkedTo` +
  `assetId` + `applicationId` in **one** `setFilters` navigation (#217 — no clobber regression).
  Activated-Restraint compliant (ADR-0049 — bone `bg-popover`, indigo only as the selected-row tint +
  check, neutral count; motion behind `prefers-reduced-motion`).

### Reverse KB lookups become paginated + filterable (#220, 2026-06-05)

The reverse lookups `GET /assets/:id/articles` and `GET /applications/:id/articles` ("the runbook for
THIS server / this app") shipped as an **unbounded** `findMany` — every linked PUBLISHED article in one
request, no filter, no paging. For a large KB linked to one ERP/app that doesn't scale. They are now
**paginated + filterable**, reusing the existing list machinery rather than a new bespoke surface
(Activated Restraint, ADR-0049):

- **Wire shape change (breaking).** Each endpoint now returns the lean `Page<ArticleListItem>` envelope
  (`{ items, total, limit, offset }`, [[0030-list-pagination-contract]]) instead of a bare
  `ArticleListItem[]`. The `@ApiOkResponse` is the page DTO. Front and back moved in lockstep
  (`endpoints/article-links.ts`, the `use*Articles` hooks, `RelatedArticlesPanel`).
- **Service.** `findArticlesForAsset` / `findArticlesForApplication` take a `(filters, page)` signature
  and run the page `findMany(take/skip)` + a paired `count` over the **same** `where` in one
  `$transaction` (via the shared `offsetOf`/`pageOf`), through a private `findLinkedArticlesPage` engine
  that flattens `_count.links → linkCount`. `limit` defaults to 50, hard-capped at 200 (a larger value
  is **rejected** with 400, not clamped — ADR-0030).
- **Filters.** `q` (case-insensitive substring over title/excerpt), `status` and `categoryId` —
  multi-select (#198), parsed by the controllers with `parseEnumArrayQuery` / `parseCuidArrayQuery`
  (unknown element → **400**, never silently ignored).
- **Privacy unchanged.** The `where` still **hard-pins `status: 'PUBLISHED'`** and ANDs the link scope
  + filters on top — a draft never leaks (a `status=DRAFT` filter validly parses but matches nothing).
  `article:read`-gated, soft-delete rules unchanged. The panel exposes only a `q` search + a **category**
  filter (no status control, which could only surface drafts or be a no-op) and "Load more" paging.

### Search: index article content

- `projectArticle` now includes **`content`** in the Meilisearch document ([[0035-search-architecture]]),
  so runbook bodies become findable — not just title/excerpt. Draft privacy is unchanged: **only
  PUBLISHED** articles are ever indexed, so indexing a DRAFT's content is structurally impossible.
  Re-run `bun run reindex:all` after deploy to backfill `content` into the live index.

## Considered options

- **Snapshot table (chosen).** A full row-copy per edit. Simplest, matches AssetHistory, trivially
  answers "what did it say at version N". Storage cost is acceptable for a 5–20-person team's KB. ✅
- **Diff/patch chain** (store deltas, reconstruct by replay) — smaller, but complex to read, fragile
  to a corrupt link, premature optimization. ❌
- **Polymorphic single link FK** (one `targetType` + `targetId`) for linking — no real FK integrity,
  no per-target cascade; rejected in favor of two real nullable FKs + a CHECK. ❌
- **A generic "related entities" graph** — over-engineered; only assets and applications are in
  scope. ❌

## Consequences

- **Positive:** auditability restored for the KB (no edit ever loses the prior body); the KB becomes
  IT-native ("the runbook for THIS server/app"); runbook bodies are searchable. All additive — no
  existing column reshaped, MVP reads/writes unchanged except the in-transaction snapshot.
- **Trade-offs / accepted debt:**
  - Storage grows by a full row per edit (fine at this scale; revisit if a hot article churns).
  - The version write doubles each KB mutation into a transaction (negligible at this scale).
  - **No rollback-to-version** and **no UI** yet (frontend KB version/link UI is a later wave).
  - Linking is asset/application only — no article↔article or article↔location links. **Resolved
    for article↔article (2026-06-11, [[0059-kb-folders-links-and-import]]):** `[[slug]]` wiki-links
    + backlinks ship as a **separate** materialized edge ([[article-wiki-link]]), distinct from this
    `ArticleLink` IT-native (article↔asset/application) join — see the open-question resolution below.
    article↔location remains deferred.
  - `ArticleLink` has no soft delete by design (it is current-state, not auditable history); if an
    audit trail of link changes is ever needed it becomes an append-only ledger (a later ADR).

## Open questions

- **Restore-to-version** — replay a past `ArticleVersion` onto the live article (writes a new
  version)? Deferred.
- ~~**Article↔article links**~~ **Resolved (2026-06-11, [[0059-kb-folders-links-and-import]]):**
  this ADR scoped linking to asset/application and explicitly deferred article↔article. [[0059]]
  ships it as a **distinct** model — materialized [[article-wiki-link]] edges computed from `[[slug]]`
  on save (powering **backlinks** + fast resolution) plus nav-only [[article-alias]] symlinks — **not**
  an extension of `ArticleLink` (which stays the IT-native article↔asset/application join). article↔location is still deferred.
- **Retention** — cap/prune very old versions? Not for now (append-only, keep everything).
- ~~**Reverse link list for applications** — `GET /applications/:id/articles`~~ **Resolved
  (2026-06-01, ADR-0030 amendment):** the application reverse lookup shipped, symmetric to the asset
  one (PUBLISHED only, lean list shape). **Now paginated + filterable (2026-06-05, #220)** — see the
  reverse-KB-lookups section above; both surfaces return `Page<ArticleListItem>` with `q`/`status`/
  `categoryId` filters.

Related: [[article]] · [[article-version]] · [[article-link]] · [[asset-history]] ·
[[0021-knowledge-base-design]] · [[0059-kb-folders-links-and-import]] ·
[[0060-kb-folder-access-control]] · [[article-wiki-link]] · [[article-alias]] · [[folder]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[0030-list-pagination-contract]] · [[0035-search-architecture]] ·
[[0022-draft-visibility-auth-shim]] · [[0040-rbac-roles]] ·
[[0041-soft-delete-reuse-and-restore]]
