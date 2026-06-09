---
title: Notification
tags: [domain, entity, notifications, rbac, frontend]
status: accepted
created: 2026-06-09
updated: 2026-06-09
---

# Notification

> 🟢 implemented · Area: Operational nudges (the topbar bell) · see [[0056-in-app-notification-bell]] · issue #313

## Purpose

The **in-app notification bell** store — a small, curated set of "an admin should glance at this"
operational nudges (access to a **critical** application was granted, a user was raised to **ADMIN**, a
consumable crossed **below minimum stock**, a workflow run **needs a human** / **failed**). It is
**append-only** (one immutable row per event) with a **per-admin read join** computed
**fan-out-on-READ**, delivered by **poll** in v1 (SSE is a Phase-2 upgrade behind the *same* API).

It is deliberately **distinct from** the [[recent-activity]] dashboard view: that view is a derived
`UNION ALL` with **no stable per-row id**, so per-item "mark read" is impossible against it, and it is
too coarse (every state change). The bell needs its **own** per-row-addressable, curated store.

Notifications are **operational nudges, NOT the audit system-of-record** — the append-only history
tables and ledgers ([[asset-history]] / [[consumable-movement]] / [[access-grant]] / [[workflow-run]])
remain that. The bell is allowed to **forget**: a **90-day retention sweep** prunes old rows + their
read joins.

## Model

Two models (`apps/api/prisma/schema.prisma`, migration `…_add_notifications`):

- **`Notification`** — append-only (`createdAt` only, **no** `updatedAt`/`deletedAt`; [[0006-soft-delete-and-auditing]]),
  `cuid()` id. Columns: `type` (the closed shared enum, plain `String` like `RolePermission.permission`),
  `severity` (`info`|`warning`|`critical` — a render cue, not a business criticality), a `title`/`summary`,
  a **soft, polymorphic** `entityType`/`entityId` deep-link target (NOT a FK — the bell points at
  heterogeneous entities and must be free to forget), an optional `targetUserId` (the person the nudge is
  about — a real `SetNull` FK to [[user]]), a small **redacted** `metadata` jsonb (names/ids only, never
  bodies/secrets — INV-6), and a **`dedupeKey`** (`UNIQUE`).
- **`NotificationRead`** — the per-admin read join `{ notificationId, userId, readAt }`, **unique on
  `(notificationId, userId)`**, written lazily on first mark-read. Absence of a row = **unread** for that
  admin. FK to `Notification` is **Restrict** (the retention sweep deletes the joins first, then the
  event — the only deleter); FK to [[user]] is **Cascade** (losing a user drops only that user's read
  rows, never the event).

"Unread for admin A" = a `Notification` with no `NotificationRead` row for A; **unread count** is one
anti-join over the small admin cohort.

## Types (closed shared enum — `@lazyit/shared`)

`critical_app_access` · `admin_granted` · `low_stock` · `workflow.manual_task` · `workflow.run_failed`.
Catalog-as-code: a typo can't mint a type, and `api` (emit) + `web` (render a closed set of icons/copy)
agree by construction. Adding a type later is an additive shared-package change.

## Emitters (best-effort, POST-COMMIT)

Fired **after** the originating transaction commits, **best-effort** (a failed emit **never** rolls back
or blocks the domain write — the AccessGrant-outbox decoupling). Idempotent via `dedupeKey`:

- **`AccessGrant.create`** → `critical_app_access` when `Application.isCritical`; `admin_granted` when the
  grant's `accessLevel` is admin-level. Dedupe `<type>:<accessGrantId>`.
- **`Consumable.createMovement`** → `low_stock` **only on the downward crossing** (above `minStock` →
  at/below it); an already-low, flapping consumable does not re-fire. Dedupe `low_stock:<id>:<YYYY-MM-DD>`
  (a coarse daily bucket — one nudge per consumable per day, re-alerts on a genuine re-cross another day).
- **`ManualTask` creation** (the engine pausing a run for a human) → `workflow.manual_task`. Dedupe
  `<type>:<manualTaskId>`.

## API (poll, gated `notification:read` — ADMIN-only)

- `GET /notifications` — the caller's feed (newest-first, paged; `Page<Notification>` per [[0030-list-pagination-contract]]),
  each item with its per-caller `read` flag.
- `GET /notifications/unread-count` — the badge number (`{ unread }`).
- `PATCH /notifications/:id/read` — mark one read (idempotent upsert) → `{ marked, unread }`.
- `PATCH /notifications/read-all` — mark all the caller's unread read → `{ marked, unread }`.

A new **`notification:read`** permission is seeded **ADMIN-only** (in `ADMIN_ONLY_READS`, like
`logs:read`/`workflow:read`). SSE is a Phase-2 drop-in behind these **same** endpoints — no contract churn.

## Frontend

The topbar bell (`apps/web/components/notification-bell.tsx`, mounted in `app/(app)/layout.tsx`) is gated
by `useCan('notification:read')` — **hidden** for non-admins. It polls the unread count (~45s) for the
badge and the recent page while open, **reuses the [[recent-activity]] activity-row visual grammar**, and
each row deep-links to its target (the application / consumable / the manual-task inbox). Mark-read on
click + "mark all read".

## Related

[[0056-in-app-notification-bell]] · [[recent-activity]] · [[manual-task]] · [[access-grant]] ·
[[consumable-movement]] · [[0046-roles-permissions-v2]] · [[0006-soft-delete-and-auditing]] · issue #313
