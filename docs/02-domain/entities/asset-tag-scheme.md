---
title: AssetTagScheme
tags: [domain, entity]
status: accepted
created: 2026-06-20
updated: 2026-06-20
---

# AssetTagScheme

> 🟢 implemented · Area: Assets (config) · lazyit's first instance-config entity

## Purpose

The org-wide, single-row, **opt-in** config entity that controls whether new [[asset]]s receive an
auto-assigned `assetTag` on create. OFF by default — without an enabled scheme the create path is
byte-for-byte unchanged ([[0063-configurable-asset-tag-scheme]]).

This is lazyit's **first instance-config entity**: one row for the whole instance, never per-user or
per-asset. It is not a join table or domain event; it is a mutable config singleton that lives
alongside the domain (analogous to how a settings row sits in the same DB).

## Relationships

- **drives auto-allocation** on [[asset]] create — the `AssetTagSchemeService.allocateTag` path reads
  this row and either returns a rendered tag or falls through.
- **no foreign keys** — standalone config, not a join.

## Business rules

- **Singleton.** The only valid `id` value is the literal string `"singleton"` — a `CHECK` constraint
  in the migration pins it. There is exactly one scheme row for the instance; a second row is
  structurally impossible.
- **OFF by default.** `enabled = false` until an admin deliberately turns it on (`settings:manage`
  only). `GET /config/asset-tag-scheme` always returns a concrete shape; when no row exists it
  returns the explicit unset/disabled default (`enabled: false`, no affixes, `nextNumber: 1`) — never
  a `404` ([[0063-configurable-asset-tag-scheme]] §4).
- **Monotonic counter.** `nextNumber` is the NEXT sequence value to allocate. It is incremented
  atomically (`{ increment: 1 }`) in a standalone `UPDATE` that **commits independently** of the
  asset-create `$transaction`. This means a rolled-back asset insert **never un-consumes** its
  number. **Gaps are accepted** — a rolled-back, retried, or deleted allocation is never back-filled.
- **Skip-existing invariant ([[0068-asset-tag-existing-estate-awareness]] §1).** An auto-allocated
  tag is never a tag already on a live asset. On each allocation the service pre-scans live tags
  matching the current affixes and jumps the counter past any contiguous occupied block in one atomic
  step, then consumes the first free slot. The live-only partial-unique index on `assets.assetTag`
  ([[0041-soft-delete-reuse-and-restore]]) is the concurrency backstop — a P2002 on that index causes
  the allocator to advance and retry (gaps accepted).
- **Disabling never rewinds.** Setting `enabled = false` leaves `nextNumber` where it is. When
  re-enabled the sequence continues from the stored counter, never restarts.
- **`startNumber` reseeds.** The `PUT` endpoint accepts an optional `startNumber` that (re)seeds
  `nextNumber`; omitting it leaves the counter untouched — so toggling `enabled` is safe.
- **Backfill ([[0068-asset-tag-existing-estate-awareness]] §3/§4).** When the scheme is first enabled
  against an existing estate, an audited bulk-retag is available (`settings:manage`):
  - **Preview** (`GET …/backfill/preview`) — read-only, paginated, writes nothing; `proposedTag` is
    indicative (the counter is NOT consumed).
  - **Apply** (`POST …/backfill/apply`) — forward-only, no undo; each retag writes an
    [[asset-history]] row. Two modes: `untagged-only` (safe default — only assets with no tag) and
    `normalize-non-conforming` (opt-in — also retags tags that don't match the scheme; conforming
    manual tags are never touched).
- **Seed suggestion.** `GET …/seed-suggestion` parses live tags matching the in-progress affixes and
  returns `max + 1` as a suggested `startNumber` so the counter starts above the existing estate
  ([[0068-asset-tag-existing-estate-awareness]] §2). Read-only.
- **Not soft-deletable.** No `deletedAt` — mutable instance config is disabled via `enabled = false`,
  not soft-deleted ([[0006-soft-delete-and-auditing]]). Explicitly kept out of `SOFT_DELETABLE_MODELS`
  so reads are not auto-scoped to `deletedAt: null` (the column doesn't exist).
- **Forbidden to service principals.** The config surface is guarded by
  `ServicePrincipalForbiddenGuard` — a non-human actor must never reconfigure the org-wide tag scheme.

## Conventions

- **ID:** fixed literal `"singleton"` — not a generated key ([[0005-id-strategy]]). No `uuid()` /
  `cuid()` — the key is a known constant, pinned by a CHECK.
- **Timestamps:** `createdAt`, `updatedAt`. **No `deletedAt`** — not soft-deletable by design
  ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `AssetTagScheme` → table `asset_tag_scheme`. Validation schemas (`AssetTagSchemeSchema`,
`UpdateAssetTagSchemeSchema`) live in `@lazyit/shared`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Fixed singleton key — only valid value is `"singleton"`. A migration CHECK enforces this; never a generated ID. |
| `prefix` | `string?` | Optional free-text affix prepended to the rendered tag (e.g. `"LAZY-"`). `null` = none. |
| `suffix` | `string?` | Optional free-text affix appended to the rendered tag. `null` = none. |
| `width` | `int?` | Optional zero-pad width for the number (e.g. `5` → `00042`). `0` / `null` = no padding. |
| `nextNumber` | `int` | The monotonic counter: the NEXT sequence value to allocate. `@default(1)`. Incremented atomically, independent of the asset-create transaction — gaps accepted. |
| `enabled` | `boolean` | `@default(false)` — OFF by default; the scheme must be deliberately enabled. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |

No `deletedAt` — not soft-deletable.

## Endpoints

`apps/api/src/asset-tag-scheme/` (`AssetTagSchemeModule`). All routes require `settings:manage` and
are forbidden to service principals.

- `GET /config/asset-tag-scheme` — read the scheme (or its unset/disabled default when no row exists).
- `PUT /config/asset-tag-scheme` — upsert the scheme; body `{ enabled, prefix?, suffix?, width?, startNumber? }`.
- `GET /config/asset-tag-scheme/seed-suggestion?prefix=&suffix=&width=` — suggest a seed `startNumber`
  from the in-progress affixes (read-only).
- `GET /config/asset-tag-scheme/backfill/preview?mode=&page=&pageSize=&modelId=` — paginated
  read-only projection of assets the backfill would retag (counter not consumed).
- `POST /config/asset-tag-scheme/backfill/apply` — deliberate bulk retag; body
  `{ mode, excludeIds?, modelId? }`; returns `{ tagged, skipped }`.

Related: [[asset]] · [[asset-history]] · [[0063-configurable-asset-tag-scheme]] ·
[[0068-asset-tag-existing-estate-awareness]] · [[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] ·
[[0041-soft-delete-reuse-and-restore]]
