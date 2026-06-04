---
title: UserHistory
tags: [domain, entity]
status: accepted
created: 2026-06-04
updated: 2026-06-04
---

# UserHistory

> 🟢 implemented · Area: Users · DEBT-2 (issue #185) · see [[0050-user-history-and-activity-user-entity]]

## Purpose

An **append-only** log of discrete lifecycle events for a [[user]] — provisioning, profile edits,
RBAC role changes, offboard (soft delete), restore and password-reset triggers. The User counterpart
of [[asset-history]]: it closes the gap where the User entity, alone among the mutable domain entities,
had no durable, queryable audit trail (only fire-and-forget IdP write-back log lines —
[[0043-zitadel-source-of-truth]] §3). Provides the "what changed on this account, when, by whom?" trail
auditing requires ([[problem-space]]), and feeds the [[recent-activity]] view's fifth source.

## Fields

- `id` — `autoincrement()`; a log id, never exposed externally ([[0005-id-strategy]]).
- `userId` — FK → [[user]] (the **subject**), required, `@db.Uuid`, `onDelete: Restrict` (a user with
  history can't be hard-deleted; soft delete bypasses it). Mirrors `AssetHistory.assetId`.
- `eventType` — `UserHistoryEventType` enum (below).
- `payload` — optional jsonb; contextual data (e.g. `{ from, to }` on `ROLE_CHANGED`,
  `{ fields }` on `UPDATED`). Unvalidated, same posture as `AssetHistory.payload`.
- `performedById` — optional FK → [[user]], `@db.Uuid`, `onDelete: SetNull`; the **human** actor,
  resolved from the verified principal. `null` = system / unknown. (On a self-action — e.g. an admin
  editing themselves — it may equal `userId`; subject and actor are distinct relations to the same User.)
- `serviceAccountId` — optional FK → [[service-account]], `onDelete: SetNull`; the **non-human** actor
  when a service account performed the action ([[0048-service-accounts]]). A DB **CHECK** enforces
  *at most one* of (`performedById`, `serviceAccountId`) per row — honest attribution, never a fake
  human. `ActorService.resolveActor(principal)` picks the right column.
- `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]).

Indexes: `(userId, id)` (the per-user timeline) and `(createdAt)` (powers the [[recent-activity]] view).

## Events (`UserHistoryEventType`)

`CREATED` · `UPDATED` · `ROLE_CHANGED` (payload `{ from, to }`) · `DELETED` · `RESTORED` ·
`PASSWORD_RESET_SENT`. The `CREATED/UPDATED/DELETED/RESTORED` set mirrors [[asset-history]]; `ROLE_CHANGED`
and `PASSWORD_RESET_SENT` are user-specific.

## Emission

**Explicit service calls** (no interceptor), **transactional** with the change ([[0033-asset-history-event-model]]),
all from the [[user]] service:

- `create` → `CREATED` — emitted only on the **success path** (after the IdP mirror can no longer fail
  and trigger the compensating hard-delete; the `Restrict` FK would otherwise block that rollback).
- `update` → `UPDATED` on a name/email edit (payload `{ fields }`) and/or `ROLE_CHANGED` on a role
  change (payload `{ from, to }`) — both only **after** any IdP mirror commits (a reverted update never logs).
- `requestPasswordReset` → `PASSWORD_RESET_SENT`, **after** the IdP call succeeds (422/501/503 never logs).
- `remove`/`offboard` → `DELETED`, **inside** the offboarding transaction (atomic with the soft-delete).
- `restore` → `RESTORED`, atomic with clearing `deletedAt`; the idempotent already-live path emits nothing.

Actor: create/update/reset are human-only routes (`@CurrentUser` → `performedById`); offboard/restore
attribute the full principal (`@CurrentPrincipal` → human XOR service account).

## Exposure

No dedicated read endpoint yet; the events surface via the [[recent-activity]] feed
(`GET /dashboard/activity`, `entityType = 'user'`). The `(userId, id)` index leaves a future
`GET /users/:id/history` (mirroring `GET /assets/:id/history`) one endpoint away — the shared
`UserHistoryQuerySchema` is already in place.

## Business rules

- **Append-only and immutable.** Rows are written, never updated or deleted.
- **Feed visibility:** a `DELETED` row does not appear in the [[recent-activity]] feed (the view filters
  soft-deleted subjects); a `RESTORED` row does. The full timeline keeps every event regardless.

## Conventions

- **ID:** `autoincrement()` — log entity ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only (no `updatedAt` / `deletedAt`, [[0006-soft-delete-and-auditing]]).

Related: [[user]] · [[asset-history]] · [[recent-activity]] · [[service-account]] ·
[[0050-user-history-and-activity-user-entity]] · [[0033-asset-history-event-model]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[0048-service-accounts]] ·
[[0043-zitadel-source-of-truth]]
