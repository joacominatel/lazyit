---
title: "ADR-0050: UserHistory append-only log + a `user` entity in the recent-activity feed"
tags: [adr, api, database, audit, dashboard, users]
status: accepted
created: 2026-06-04
updated: 2026-06-04
deciders: [Joaquín Minatel]
---

# ADR-0050: UserHistory append-only log + a `user` entity in the recent-activity feed

## Status

accepted — 2026-06-04. Technical-debt wave 3c-3 (DEBT-2), issue #185, epic #157. Closes the audit gap
where the **User** entity — alone among the mutable domain entities — had no queryable lifecycle
history: its writes only emitted fire-and-forget IdP write-back log lines ([[0043-zitadel-source-of-truth]] §3),
which are not a durable, per-user, replayable record. Builds directly on the AssetHistory event model
([[0033-asset-history-event-model]]), the append-only auditing posture ([[0006-soft-delete-and-auditing]]),
the recent-activity view ([[0044-recent-activity-view]]) and the unified actor model
([[0048-service-accounts]]).

## Context

Every mutable domain entity keeps an append-only audit trail (`asset_history`, `consumable_movements`,
the assignment/grant close-markers, `article_versions`, `permission_audit_log`, `service_account_audit_log`).
**User** did not. Its create / profile-edit / role-change / offboard / restore / password-reset paths
([[0043-zitadel-source-of-truth]], issue #149) only wrote structured log lines — invisible to the
product, unqueryable, and gone with log rotation. The dashboard's cross-pillar recent-activity feed
([[0044-recent-activity-view]]) therefore had a blind spot: "who was provisioned / promoted / offboarded"
never appeared, even though it is exactly the kind of estate-level event that feed exists to surface.

We want (a) a durable, append-only `user_history` table that mirrors `asset_history` exactly, emitted
**transactionally** with each write it records, and (b) the recent-activity view widened with a fifth
`UNION ALL` branch so user lifecycle events stream alongside asset/access/consumable activity — which
requires widening the shared `ActivityEntityType` contract to include `"user"`.

## Considered options

1. **A new append-only `UserHistory` model mirroring `AssetHistory`, emitted in-transaction, + a fifth
   `recent_activity` view branch + widen `ActivityEntityType` to `"user"`.** *(chosen — the
   established pattern; no new concepts.)*
2. Keep using only the IdP write-back log lines. Rejected: not durable, not queryable, not in the feed
   — the exact debt this closes; and inconsistent with every other entity.
3. A single generic `audit_log` table for all entities. Rejected here: a cross-cutting redesign far
   beyond DEBT-2, and it would diverge from the per-entity-history precedent the codebase already
   commits to (`asset_history`, the six others). A consolidation, if ever wanted, is its own ADR.
4. Emit the history row OUTSIDE the write transaction (fire-and-forget, like the search sync). Rejected:
   an audit trail that can silently drift from the data it claims to record is worse than none; ADR-0033
   already established in-transaction emission as the rule.

## Decision

- **Model `UserHistory` → table `user_history`** (migration `user_history`), a 1:1 structural copy of
  `asset_history` ([[0033-asset-history-event-model]]):
  - `id` autoincrement PK (a log id, never exposed — [[0005-id-strategy]]); `userId` (the SUBJECT)
    `@db.Uuid`, **required FK with `onDelete: Restrict`** so a user's history is preserved (soft delete
    bypasses it); `eventType` enum `UserHistoryEventType`; `payload Json?` (e.g. `{ from, to }` on
    `ROLE_CHANGED`); the **actor pair** `performedById uuid? (SetNull)` + `serviceAccountId text? (SetNull)`
    with a **DB CHECK `at-most-one-actor`** — identical to the six existing audit tables
    ([[0048-service-accounts]]); `createdAt` **only** (append-only — [[0006-soft-delete-and-auditing]];
    no `updatedAt`/`deletedAt`). Indexes `(userId, id)` (per-user timeline) and `(createdAt)` (the view).
  - The Prisma-generated SQL carries the table/enum/FKs; the `CHECK` is appended as raw SQL in the same
    migration (Prisma can't express it in PSL), mirroring the service-accounts migration.
- **`UserHistoryEventType` = `{ CREATED, UPDATED, ROLE_CHANGED, DELETED, RESTORED, PASSWORD_RESET_SENT }`** —
  the AssetHistory `CREATED/UPDATED/DELETED/RESTORED` set plus the two user-specific verbs.
- **Emission (`UserHistoryService.record(client, …)`, the AssetHistory pattern):** the Users service
  passes its `$transaction` client so the log row commits **atomically** with the change. Per write-path:
  - `create` → `CREATED` — emitted **only on the success path** (after the IdP mirror could no longer
    fail and trigger the compensating hard-delete; the `Restrict` FK would otherwise block that rollback).
  - `update` profile edit → `UPDATED` (payload `{ fields: ["name"|"email"] }`); role change →
    `ROLE_CHANGED` (payload `{ from, to }`). Both emitted only **after** any IdP mirror commits, so a
    reverted update never logs. One PATCH can emit both.
  - `requestPasswordReset` → `PASSWORD_RESET_SENT`, **after** the IdP call succeeds (a 422/501/503 never logs).
  - `remove`/`offboard` → `DELETED`, **inside** the offboarding transaction (atomic with the soft-delete).
  - `restore` → `RESTORED`, atomic with clearing `deletedAt`; the idempotent already-live path emits nothing.
  - Actor: create/update/reset are human-only routes (`@CurrentUser` → `performedById`); offboard/restore
    attribute the full principal (`@CurrentPrincipal` → `ActorService.resolveActor` → human XOR service
    account), CHECK-safe by construction ([[0048-service-accounts]]).
- **`recent_activity` view — a fifth `UNION ALL` branch** (`CREATE OR REPLACE VIEW`, new migration,
  same column list/order so the replace is legal): `user_history` → `occurredAt = createdAt`,
  `actorId = performedById`, `entityType = 'user'`, `entityId = userId::text`,
  `action = lower(eventType)`, `summary` a terse line ("User created", "User role changed", …). It
  joins `users` and keeps only **LIVE subjects** (`deletedAt IS NULL`), matching every other branch's
  parent-soft-delete filter ([[0044-recent-activity-view]]). The view remains a derived read model
  (Prisma neither emits nor tracks it).
- **Contract — widen `ActivityEntityTypeSchema` to `["asset","application","consumable","user"]`** in
  `@lazyit/shared`, and add the user-specific verbs (`updated`, `role_changed`, `password_reset_sent`)
  to the `RECENT_ACTIVITY_ACTIONS` allowlist so they are filterable (`created`/`deleted`/`restored`
  already exist). A new `user-history.ts` schema (`UserHistoryEventTypeSchema`, `UserHistorySchema`,
  `UserHistoryQuerySchema`) mirrors `asset-history.ts` for the (future) read endpoint and the emitter's
  event-type type.

## Consequences

- **Positive:** the User entity now has the same durable, queryable, replayable audit trail as every
  other entity, and its lifecycle shows up in the unified feed. The per-user timeline (`(userId, id)`
  index) is ready for a future `GET /users/:id/history` with zero further schema work.
- **BREAKING-for-web (expected, handled separately on this branch):** widening `ActivityEntityType`
  makes the web's exhaustive `ENTITY_META` / `ENTITY_TONE` maps non-exhaustive — a deliberate,
  contract-driven break a frontend change resolves on the same branch (it adds the `"user"` icon/tone
  + a link target). The shared `recent-activity.test.ts` enum assertions were updated to match.
- **A `DELETED` user-history row never appears in the feed** — the view filters soft-deleted subjects,
  so the offboarding still surfaces via the released/revoked asset+access branches, while the `DELETED`
  row stays on the per-user timeline. A `RESTORED` row *does* appear (the subject is live again).
- **Residual:** like the other branches, the view re-derives soft-delete filtering in SQL (it can't
  reuse the Prisma extension). The summaries are server-built English, not localized — consistent with
  ADR-0044. The `payload` is unvalidated jsonb (matching `asset_history`).

## References

- [[0033-asset-history-event-model]] (the mirrored model + in-transaction emission) ·
  [[0006-soft-delete-and-auditing]] (append-only, `createdAt`-only) ·
  [[0044-recent-activity-view]] (the view this extends) · [[0048-service-accounts]] (the
  at-most-one-actor CHECK + `resolveActor`) · [[0043-zitadel-source-of-truth]] (the write-back log lines
  this supersedes for durability) · [[0005-id-strategy]] · [[0030-list-pagination-contract]] ·
  [[02-domain/entities/user]] · [[02-domain/entities/recent-activity]] · [[prisma-migrations]] §3.
