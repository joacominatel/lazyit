---
title: "ADR-0041: Soft-delete reuse — partial unique indexes, restore, citext email"
tags: [adr, soft-delete, database, prisma]
status: accepted
created: 2026-06-01
updated: 2026-06-01
deciders: [Joaquín Minatel]
---

# ADR-0041: Soft-delete reuse — partial unique indexes, restore, citext email

## Status

accepted — 2026-06-01 (CEO decision). Builds on [[0006-soft-delete-and-auditing]] (soft delete on
mutable domain entities), [[0032-soft-delete-middleware]] (the `$extends` read filter + the
`includeSoftDeleted` escape hatch) and [[0033-asset-history-event-model]] (the `RESTORED` event that
was reserved but never emitted). Second of the Round-2 backend PRs; stacked on the RBAC work
([[0040-rbac-roles]]) whose `RolesGuard` + `@Roles` it reuses to gate the new restore endpoints.

## Context

Every `@unique` column on a soft-deletable model was a **full** unique index. Because soft delete is
an `UPDATE` that stamps `deletedAt` (the row stays), a soft-deleted `email` / `slug` / `sku` /
`name` / `serial` / `assetTag` kept colliding **forever** against an invisible ghost row: the value
could never be recreated and there was no way to bring the deleted row back. Two concrete failures:

- Soft-delete the `"Server"` asset category, then try to recreate it → `409 Conflict` against a row
  the API can no longer even see (the read filter hides it). The name is permanently burned.
- There was **no restore anywhere** — soft delete was a one-way door, despite auditability being the
  whole point of keeping the row.

Separately, `User.email` was case-sensitive `TEXT`. With OIDC/JIT live ([[0038-jit-user-provisioning]]),
`Bob@x` and `bob@x` are the same mailbox but produced **two** users.

## Considered options

1. **Hard-delete instead** — frees the value, but destroys the audit trail. Rejected: contradicts the
   auditability-by-default principle ([[vision]], [[0006-soft-delete-and-auditing]]).
2. **Suffix the value on delete** (e.g. `email = "bob@x#deleted-<ts>"`) — frees uniqueness but mangles
   stored data and breaks restore (the original value is lost / must be parsed back). Rejected.
3. **Restore + partial unique indexes (chosen).** Scope uniqueness to LIVE rows only via a partial
   unique index `WHERE "deletedAt" IS NULL`; add restore endpoints that clear `deletedAt`. The data is
   never mutated on delete, the value frees immediately, and restore is a clean inverse.

## Decision (CEO, verbatim)

> **Soft-delete = "Restore + indices parciales (Rec.)"**: partial unique indexes
> `WHERE "deletedAt" IS NULL` to free email/slug/sku; add restore endpoints (ADMIN-gated); email
> becomes case-insensitive (citext or a `lower()` functional unique index).

Concretely:

- **Partial unique indexes.** Every `@unique` on a soft-deletable model is replaced by a PARTIAL
  unique index `WHERE "deletedAt" IS NULL`. Prisma's PSL cannot express a partial unique index, so —
  exactly like the [[asset-assignment]] precedent (`asset_assignments_assetId_userId_active_key`,
  [[0019-asset-assignment-integrity]]) — the `@unique` attribute is **removed** from the model and the
  index is written as raw SQL in the migration. Prisma neither emits nor reports these (drift stays
  green; see [[prisma-migrations]] §3). The columns covered:

  | Model | Column(s) | Index |
  | --- | --- | --- |
  | User | email | `users_email_active_key` |
  | AssetCategory | name | `asset_categories_name_active_key` |
  | AssetModel | sku | `asset_models_sku_active_key` |
  | Asset | serial, assetTag | `assets_serial_active_key`, `assets_assetTag_active_key` |
  | ArticleCategory | name | `article_categories_name_active_key` |
  | Article | slug | `articles_slug_active_key` |
  | ApplicationCategory | name | `application_categories_name_active_key` |
  | ConsumableCategory | name | `consumable_categories_name_active_key` |
  | Consumable | sku | `consumables_sku_active_key` |

  `User.externalId` is **deliberately NOT** made partial — it stays a full `@unique`. The JIT path
  upserts on `externalId` (`prisma.user.upsert({ where: { externalId } })`), which requires a true
  unique key, and offboarding-sticks logic intentionally 403s a soft-deleted user with a matching
  `sub` rather than re-provisioning ([[0038-jit-user-provisioning]]). Freeing it would weaken both.

- **Case-insensitive email (citext).** `users.email` becomes `CITEXT` (`CREATE EXTENSION IF NOT
  EXISTS citext` in the migration, `@db.Citext` in the schema), so the partial unique index above is
  case-insensitive — `Bob@x` and `bob@x` can never become two live users. Input is also **normalized**
  (`trim` + `toLowerCase`) in the `@lazyit/shared` write schemas (`EmailSchema`, used by
  `CreateUserSchema` / `UpdateUserSchema`) and in the JIT provisioning path, so the stored value is
  canonical and the application layer agrees with the column. citext was chosen over a `lower()`
  functional index because it makes the column itself case-insensitive (every comparison, not just the
  index), with no per-query `lower()` discipline to remember.

- **Restore endpoints.** `POST /<resource>/:id/restore`, **ADMIN-gated** (`@Roles(Role.ADMIN)`,
  reusing the [[0040-rbac-roles]] `RolesGuard`), for User, Asset, Article, Application, Location,
  Consumable, AssetModel and the four categories. Each finds the row through the `includeSoftDeleted`
  escape hatch (the read filter would otherwise hide it), 404s if it never existed, is idempotent if
  already live, and clears `deletedAt`. A restore can legitimately **409** if a live row took the
  freed value in the meantime — surfaced by the global `PrismaExceptionFilter` (P2002 → 409).
  - **Asset restore emits a `RESTORED` `AssetHistory` event** transactionally (the counterpart of
    `DELETED`), finally giving the enum value reserved in [[0033-asset-history-event-model]] an emitter.
  - **Article restore is author-only** (mirrors its delete) and re-indexes only if PUBLISHED (draft
    privacy, [[0022-draft-visibility-auth-shim]]).
  - **User restore does NOT** re-grant the access or re-assign the assets that offboarding
    revoked/released — restore only makes the account exist (and log in) again; re-onboarding access is
    a separate, intentional act.
  - Restore re-indexes the row for search where the entity is indexed ([[0035-search-meilisearch]]).

## Consequences

- **Positive:** soft-deleted values are immediately reusable; deletes are reversible (Restore); audit
  rows are never mutated or lost; the email duplicate-user class is closed; the pattern matches the
  existing AssetAssignment partial-index precedent, so there's nothing new to learn.
- **Seed change:** the seed could no longer `upsert({ where: { name | email } })` (those are no longer
  unique keys). It now does an explicit find-among-LIVE-rows-then-create (still idempotent).
- **Invisible indexes:** the partial indexes live only in migration SQL — Prisma can't model them, so
  they're documented at each model and here (same trade-off as AssetAssignment).
- **Restore can 409** when the freed value was reused by a live row before the restore — correct
  behaviour (you can't have two live rows with the same key), reported as a 409 to the caller.
- **No bulk/cascade restore:** restoring a parent (e.g. a category) does not restore its children, and
  vice-versa — each restore is a single, explicit action. Acceptable at small-team scale; revisit if a
  "restore tree" need appears.
- **Listing the soft-deleted rows (so they can be restored from the UI):** the five primary lists
  (`/assets`, `/applications`, `/consumables`, `/users`, `/locations`) take an ADMIN-only
  **`deleted=only`** query param that returns the archived slice (default/absent = `active`, live rows
  only). It bypasses the [[0032-soft-delete-middleware]] read filter via the sanctioned
  `includeSoftDeleted` escape hatch and is gated at the controller (a non-admin → 403). Full contract:
  [[0030-list-pagination-contract]] amendment §7.

## Related

[[0006-soft-delete-and-auditing]] · [[0032-soft-delete-middleware]] · [[0033-asset-history-event-model]] ·
[[0019-asset-assignment-integrity]] · [[0038-jit-user-provisioning]] · [[0040-rbac-roles]] ·
[[0030-list-pagination-contract]] · [[prisma-migrations]] · [[user]] · [[asset]] · [[asset-history]]
