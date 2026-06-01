---
title: "ADR-0030: List endpoint pagination contract (offset; implementation deferred)"
tags: [adr, security, api]
status: accepted
created: 2026-05-25
updated: 2026-06-01
deciders: [Joaquín Minatel]
---

# ADR-0030: List endpoint pagination contract (offset; partially implemented)

## Status

accepted — 2026-05-25; **partially implemented 2026-05-30** (Round 1, backend). The contract was
decided 2026-05-25 with implementation deferred. It now lives in `@lazyit/shared`
(`schemas/pagination.ts`: `PageQuery`/`Page<T>` + `offsetOf`/`pageOf` helpers, default 50 / hard
max 200, over-max rejected with 400) and the three heaviest/most-sensitive lists are paginated:
**`GET /access-grants`**, **`GET /assets`** and **`GET /articles`** each gained a service
`findPage(...)` (`findMany`+`count` over one `where` in a `$transaction`). The remaining lists
(small reference tables + the inherently-scoped nested grant/assignment lists) stay unpaginated for
now. Raised by [[SEC-007-no-pagination-list-endpoints|SEC-007]]; the response shape lives alongside
[[0018-api-documentation-swagger]] and is consumed by the frontend data layer
([[0020-frontend-data-layer]]).

## Context

No list endpoint paginates (SEC-007): every `findAll` returns all non-soft-deleted rows with no
`take`/`skip`/cursor. At the current MVP scale (a 5–20-person team) this is invisible, but it is an
unbounded-response/DB-load cliff as data grows — `articles`, the append-only `asset_assignments` /
`access_grants` history, and `assets` over time. We want to **fix the contract now** (so new
endpoints follow one convention and nobody re-litigates it) **without** the large refactor of all
eleven lists plus the frontend data layer today.

## Considered options

1. **Offset / limit** (`skip` / `take`): simplest and familiar; degrades on deep pages and is
   slightly unstable under concurrent inserts. *(chosen)*
2. **Cursor-based** (id / `createdAt` cursor): scales best for the growing/append-only tables and is
   stable under inserts; richer client contract and more code.
3. **Defer entirely** — make no decision and keep lists unbounded.

## Decision

- Adopt an **offset/limit** contract, defined **once in `@lazyit/shared`**: a `PageQuery`
  (`{ limit, offset }`, or `{ page, limit }`) and a `Page<T>` envelope
  (`{ items, total, limit, offset }`). **Default page size 50, hard maximum 200** — a `limit` over
  the max is **rejected (400)**, never silently clamped.
- **Migration is incremental, highest-risk first.** Round 1 (2026-05-30) implemented the contract
  and paginated the three heaviest/most-sensitive lists — **`GET /access-grants`** (the most
  sensitive unbounded list — it can dump every user↔application grant), **`GET /assets`** (the
  heaviest) and **`GET /articles`** — each via a service `findPage(...)` that runs `findMany` +
  `count` over the same `where` in one `$transaction`. The remaining small reference lists and the
  inherently-scoped nested grant/assignment lists stay unpaginated for now; **new** list endpoints
  adopt the contract from the start.
- When implemented, it spans backend **and** frontend (TanStack Query, [[0020-frontend-data-layer]])
  → split into separate front/back subagents per the workflow, not done piecemeal. **Frontend
  follow-up (2026-05-31):** the three list fetchers (`getAssets` / `getArticles` /
  `getAccessGrants`) first requested the `Page<T>` envelope and **unwrapped `.items`**, showing only
  the first page (default size 50) with `total` available for a future control.
- **Frontend pagination UI (2026-06-01):** the three fetchers/hooks now thread `limit`/`offset` and
  **return the whole `Page<T>` envelope** (`items` + `total`/`limit`/`offset`) rather than unwrapping
  to an array. The list screens own an `offset` state (reset to 0 on any server-filter change, derived
  during render rather than via an effect) and render a shared `Pagination` footer
  (`components/resource-table.tsx`: visible range + total + prev/next, offset-based math) — wired into
  the **assets** table and the **kb/articles** card list; `keepPreviousData` keeps the prior page on
  screen so paging never flashes the skeleton. The **applications/Access** screen consumes
  `getAccessGrants` only for per-app counts, so it requests the hard-max page (`limit = 200`) and stays
  unpaginated. **Column sort is client-side over the current page** (the `Page<T>` contract carries no
  `sort` param) — the asset table sorts name / asset-tag / status / updated on the loaded rows only; a
  server-side ordered list is a future backend follow-up. Consumables and the small reference lists are
  not backend-paginated, so they gained no controls.
  **(Superseded 2026-06-01 by amendment §6 below — sort is now server-side and authoritative, all six
  lists paginate, and list view-state lives in the URL.)**

## Consequences

- **Positive:** the pagination contract is decided, discoverable and now enforced on the three
  highest-risk lists; the heaviest payloads are also trimmed (lean `select`s: `GET /articles` drops
  the markdown `content`, `GET /assets` drops the `specs` blob + trims joins). New endpoints inherit
  a capped page size by default.
- **Residual (tracked):** the remaining (small / inherently-scoped) lists stay unbounded until
  migrated — [[SEC-007-no-pagination-list-endpoints|SEC-007]] remains **open** as bounded, accepted
  debt. Offset pagination's deep-page cost and insert-instability are accepted at this scale; revisit
  **cursor** (option 2) if a history table grows fast. Matching **partial `deletedAt` indexes** for
  the now-bounded hot lists are a Round 2 follow-up (no migration landed in Round 1). The lean
  `GET /assets` row also **drops `activeAssignments[].user.deletedAt`**, so the asset list can no
  longer dim a departed (soft-deleted) owner's avatar — re-add that field to `AssetListAssignment`
  (backend) if list-level dimming is wanted; the detail read (`GET /assets/:id`) still carries it.
- The hard max (200) caps the worst-case response size for any endpoint that adopts the contract.

## Amendment (2026-06-01) — sort contract, full list migration, lean-owner `deletedAt`, batch actions

A UX/UI audit found correctness bugs in the list/data layer. This amendment fixes them — all
**additive**, **no migration** (query params, projection changes and new endpoints on existing models).

### 1. Sort is now part of the `Page<T>` contract

`PageQuery` gained two optional params — **`sort`** (a field name) and **`dir`** (`asc` | `desc`,
defaulting to `asc` only when `sort` is present; with no `sort` the service keeps its own default
order). The shape only validates that they are well-formed strings; **the set of sortable fields is
per-resource**, validated against an **ALLOWLIST** by each list endpoint. An unknown `sort` is
**rejected with 400** (`resolveSort` → `UnknownSortFieldError` → `BadRequestException` via
`common/resolve-sort.ts`), **never silently ignored** — so a sort always means what it says. The
allowlist maps each PUBLIC `?sort=` key to the Prisma column (the wire key may differ from the
column, and the surface is bounded so a client can never order by an arbitrary/secret field).

The asset list's previous client-side, page-local sort (a trust bug — it presented as a global sort
but only re-ordered the loaded page) is replaced by a **real server-side `orderBy` over the full
result set**.

Per-resource sortable-field allowlists:

| Endpoint | `sort` keys | default order |
| --- | --- | --- |
| `GET /assets` | `name`, `assetTag`, `serial`, `status`, `createdAt`, `updatedAt` | `createdAt desc` |
| `GET /applications` | `name`, `vendor`, `isCritical`, `createdAt`, `updatedAt` | `name asc` |
| `GET /consumables` | `name`, `sku`, `currentStock`, `createdAt`, `updatedAt` | `name asc` |
| `GET /users` | `firstName`, `lastName`, `email`, `role`, `createdAt` | `createdAt desc` |
| `GET /locations` | `name`, `type`, `createdAt`, `updatedAt` | `createdAt desc` |

### 2. Four more lists migrated onto `Page<T>` + server-side `q` + sort

`GET /applications`, `GET /consumables`, `GET /users` and `GET /locations` previously returned **raw
arrays** that the frontend filtered client-side — so search silently missed anything past the
backend window (false "no results"). They now use a service `findPage(...)` (`findMany` + `count`
over one `where` in a `$transaction`), with a **server-side case-insensitive `q`** over the sensible
text fields and the allowlisted sort. The lists stay lean (no heavy joins/blobs). Search is now
authoritative; silent truncation is gone. New envelope schemas live in `@lazyit/shared`
(`application-list.ts`, `consumable-list.ts`, `user-list.ts`, `location-list.ts`). `q` columns:
applications → name/vendor/url/description · consumables → name/sku/description (the `lowStock`
filter is preserved) · users → firstName/lastName/email · locations → name/address/floor/description.

### 3. Lean asset-owner `deletedAt` re-added

The Round-1 residual is closed: `AssetListAssignment.user` (and the `ASSET_LIST_SELECT` projection)
again carries **`deletedAt`**, so the **asset list** can dim a departed (soft-deleted) owner's
avatar — matching the detail read. (The soft-delete extension only filters the top-level query, so a
nested join's `user` row is still returned with its `deletedAt`; the field is populated.)

### 4. KB `ArticleLink` reverse lookup for applications (ADR-0042)

`GET /applications/:id/articles` now returns the PUBLISHED articles linked to an application
("the runbook for THIS app"), mirroring the existing `GET /assets/:id/articles`. The forward
link endpoints already existed (`GET/POST/DELETE /articles/:id/links`, ADMIN/MEMBER author-gated).
Reverse lists return the lean `ArticleListItem` shape (no markdown content) and exclude DRAFTs.

### 5. Batch (bulk) mutation endpoints — ADMIN only

Multi-select actions: `POST /assets/batch/delete`, `POST /assets/batch/restore`,
`POST /assets/batch/status` and `POST /access-grants/batch/revoke`. Payload is a non-empty,
de-duplicated, **bounded (≤ 200)** id list (`@lazyit/shared/batch.ts`); the response is a
`BatchResult` (`{ requested, succeeded[], skipped[{id, reason}] }`).

**Auditability semantics (decided):** a batch runs in **ONE transaction** but keeps **per-entity
auditability — one `AssetHistory` event (or per-grant revoke) per item, never one entry for the
whole batch.** A batch is a convenience over N single-item actions, not a different audit event, so
per-entity history is preserved exactly as the single-item path records it (`DELETED` / `RESTORED` /
`STATUS_CHANGED` with `{from,to}` for assets; `revokedAt`/`revokedById` per grant). An id that is a
**no-op** (not found, already deleted/restored/revoked, or already at the target status) is
**skipped** with a reason — never an error — so a partial multi-select still commits.

### 6. Frontend list-chain — URL view-state, server sort UI, pagination + responsive (2026-06-01)

The web consumes §§1–3 across **all six list pages** (assets, applications/Access, consumables,
users, locations, kb). This supersedes the "Frontend pagination UI" bullet above:

- **URL is the source of truth for list view-state.** Each list page replaced its local
  `useState` cluster (search / filters / sort / offset) with one **`useListParams(...)`** call
  (`lib/hooks/use-list-params.ts`): `q` / `sort` / `dir` / `limit` / `offset` / named `filters`
  all live in the query string, so a filtered list is shareable, bookmarkable and Back-navigable,
  and the **dashboard deep-links** into a pre-filtered list. `q`/filter changes reset paging to
  the first page; sort/page changes do not.
- **The four interim fetchers** (`getUsers` / `getLocations` / `getApplications` /
  `getConsumables`) now take a params object and **return the whole `Page<T>` envelope** (no more
  `.then(p => p.items)`). To avoid breaking the screens that join a resource client-side (asset
  owners, access grantees, article authors, the asset form's location/category pickers), the bare
  directory hooks (`useUsers` / `useLocations` / `useApplications`) keep their **`Entity[]`**
  contract by requesting the hard-max page (200) and `select`-ing `items`; new **`useUserList` /
  `useLocationList` / `useApplicationList`** hooks return the envelope for the list pages.
  Consumables only powers its own list, so `useConsumables` returns the envelope directly.
- **Server sort is wired to the UI.** Sortable column headers (`SortableHeader` →
  `toggleSort(field)`) only expose the per-resource allowlist (§1); the order is recomputed by the
  API over the **full** result set, not the page. Non-allowlisted columns (model/owners/category,
  consumable unit, user "Updated", …) are intentionally **not** sortable.
- **Server vs client filters.** Where the API has a real filter param it is threaded through `q`/the
  list params (`assets` → `status`/`categoryId`/`locationId`; `consumables` → `lowStock`; `kb` →
  `status`/`categoryId`). Filters the API does NOT support are applied **client-side over the current
  page** and documented as such — `assets` ownership, `applications` category + criticality,
  `consumables` category, `users` active/inactive, `locations` type. The URL param names (the
  dashboard deep-links + bookmarks depend on these): `assets` `status`/`category`/`location`/`ownership`;
  `applications` `category`/`criticality`; `consumables` `lowStock`(=`"true"`)/`category`; `users`
  `status`; `locations` `type`; `kb` `status`/`categoryId`.
- **Pagination + RBAC + recovery.** Every list renders the shared `Pagination` footer over `total`;
  the "New X" button, per-row Edit/Delete and the consumables ±1 quick-adjust are gated on
  `useCanWrite()` (ADR-0040) so a VIEWER never sees a control that would 403. Active filters show as
  dismissible chips with a **"Clear all"** (`components/active-filters.tsx`), and the filtered-empty
  row offers a **"Clear filters"** link.
- **Responsive.** `components/resource-table.tsx` gained a `mobileChildren` slot + `ResourceCard` /
  `ResourceCardMeta` primitives: below `md` each list stacks into touch-friendly cards (status /
  owners / quick-adjust kept visible, ≥44px targets); the `<table>` shows at `md` and up.
- **Departed owners** are dimmed on the asset list using the re-added
  `activeAssignments[].user.deletedAt` (§3).
- **Dashboard.** "Needs attention" now leads (above the count cards); every attention row + pillar
  breakdown deep-links into the matching pre-filtered list (same URL params above); `generatedAt`
  surfaces as "Updated <relative>" beside a **Refresh** button; ADMIN-gated quick actions (New asset
  / Add stock / Grant access); the bespoke error card is replaced by the shared `ErrorState`; and the
  activity feed's avatar-color copy is deduped onto `lib/avatar-color.ts`'s `avatarColorFor`.
- **Deferred** (a follow-on wave, building on this): bulk multi-select / batch-action bar (§5) and
  the "Show archived"/restore toggle.

## References

- [[SEC-007-no-pagination-list-endpoints|SEC-007]].
- [[0018-api-documentation-swagger]] (response DTOs / OpenAPI) · [[0020-frontend-data-layer]] ·
  [[0009-bun-first-vs-app-stack]] (stack).
