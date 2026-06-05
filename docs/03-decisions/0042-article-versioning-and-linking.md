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
- The link universe stays **the two target TYPES** (`asset`, `application`) — the data model has
  exactly those (article ↔ asset XOR application). Picking *specific* linked entities
  (`assetId[]`/`applicationId[]` predicates + an entity picker) is a **deferred follow-up**, not part
  of this change.
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
  - Linking is asset/application only — no article↔article or article↔location links.
  - `ArticleLink` has no soft delete by design (it is current-state, not auditable history); if an
    audit trail of link changes is ever needed it becomes an append-only ledger (a later ADR).

## Open questions

- **Restore-to-version** — replay a past `ArticleVersion` onto the live article (writes a new
  version)? Deferred.
- **Retention** — cap/prune very old versions? Not for now (append-only, keep everything).
- ~~**Reverse link list for applications** — `GET /applications/:id/articles`~~ **Resolved
  (2026-06-01, ADR-0030 amendment):** the application reverse lookup shipped, symmetric to the asset
  one (PUBLISHED only, lean list shape).

Related: [[article]] · [[article-version]] · [[article-link]] · [[asset-history]] ·
[[0021-knowledge-base-design]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[0030-list-pagination-contract]] · [[0035-search-architecture]] ·
[[0022-draft-visibility-auth-shim]] · [[0040-rbac-roles]] ·
[[0041-soft-delete-reuse-and-restore]]
