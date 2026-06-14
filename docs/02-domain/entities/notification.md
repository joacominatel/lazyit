---
title: Notification
tags: [domain, entity, notifications, rbac, frontend]
status: accepted
created: 2026-06-09
updated: 2026-06-14
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
  **about** — a real `SetNull` FK to [[user]]), an optional **`recipientUserId`** (who **sees** it — a real
  `SetNull` FK to [[user]]; the second visibility axis, [[0056-in-app-notification-bell]] amendment
  2026-06-14, #453: `null` = broadcast to every `notification:read` holder, a uuid = **targeted** to that
  user's own bell even when they hold no `notification:read`; indexed), a small **redacted** `metadata`
  jsonb (names/ids only, never bodies/secrets — INV-6), and a **`dedupeKey`** (`UNIQUE`).
- **`NotificationRead`** — the per-admin read join `{ notificationId, userId, readAt }`, **unique on
  `(notificationId, userId)`**, written lazily on first mark-read. Absence of a row = **unread** for that
  admin. FK to `Notification` is **Restrict** (the retention sweep deletes the joins first, then the
  event — the only deleter); FK to [[user]] is **Cascade** (losing a user drops only that user's read
  rows, never the event).

"Unread for admin A" = a `Notification` with no `NotificationRead` row for A; **unread count** is one
anti-join over the small admin cohort.

## Types (closed shared enum — `@lazyit/shared`)

`critical_app_access` · `admin_granted` · `low_stock` · `workflow.manual_task` · `workflow.run_failed` ·
**`secret.vault_setup`** (the targeted login nudge, #453). Catalog-as-code: a typo can't mint a type, and
`api` (emit) + `web` (render a closed set of icons/copy) agree by construction. Adding a type later is an
additive shared-package change (and a web exhaustive-map re-typecheck — `TYPE_META` is keyed on the enum).

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
- **Login** (`GET /users/me`, the app-load self-read) → **`secret.vault_setup`**, a **targeted** nudge
  (`recipientUserId = caller`) when the caller holds `secret:read` but has **no** [[user-keypair]] (they
  have never set a vault passphrase, so they can decrypt nothing — [[0061-secret-manager-zero-knowledge]]
  §7). Dedupe **`secret.vault_setup:<userId>`** (a STABLE key, no time bucket) → **one nudge per user,
  ever**; none re-fires once a keypair exists. Wired **fail-soft** in `VaultSetupNudgeService` (a
  notification problem never blocks login or `/me`). **INV-10-safe** — carries no key material, only "set
  up your vault passphrase" + a link to `/secrets`.

## API (poll) — read-path authZ (the auth contract)

- `GET /notifications` — the caller's feed (newest-first, paged; `Page<Notification>` per [[0030-list-pagination-contract]]),
  each item with its per-caller `read` flag.
- `GET /notifications/unread-count` — the badge number (`{ unread }`).
- `PATCH /notifications/:id/read` — mark one read (idempotent upsert) → `{ marked, unread }`.
- `PATCH /notifications/read-all` — mark all the caller's unread read → `{ marked, unread }`.

**Read-path authZ ([[0056-in-app-notification-bell]] amendment 2026-06-14, #453).** v1 gated all four
endpoints by `@RequirePermission('notification:read')` (ADMIN-only) — a non-admin was 403'd and could
never see the bell. Targeted notifications change that: the routes are **relaxed to any authenticated
human** (a service-account principal is still 403'd — the bell is a per-user surface), and the **service
scopes** every read to the caller's **visible set**:

- **own targeted rows** (`recipientUserId == caller`) — **always** visible, **regardless of
  `notification:read`** (the "you see your own" shape of `GET /users/me`); PLUS
- the **broadcast set** (`recipientUserId IS NULL`) — visible **only if** the caller's role holds
  **`notification:read`** (still **ADMIN-only** by default, in `ADMIN_ONLY_READS`, like `logs:read`).

The scope is one Prisma `where` (`recipientUserId = caller OR (recipientUserId IS NULL AND
notification:read)`) reused by list / unread-count / mark-read / mark-all, so they are **IDOR-safe by
construction**: mark-read first confirms the id is in the caller's visible set, so a caller can never mark
or count **another user's targeted** notification, and a non-admin can never touch a broadcast row. The
`notification:read` permission is resolved inside the service via [[0046-roles-permissions-v2]]'s
`PermissionResolverService` — no new permission is added. SSE is a Phase-2 drop-in behind these **same**
endpoints — no contract churn.

## Frontend

The topbar bell (`apps/web/components/notification-bell.tsx`, mounted in `app/(app)/layout.tsx`) reuses the
[[recent-activity]] activity-row visual grammar and deep-links each row to its target (the application /
consumable / the manual-task inbox / `/secrets` for the vault-setup nudge). Mark-read on click + "mark all
read". **NOTE (#453):** the targeted-recipient backend is built; the bell still gates the whole affordance
on `useCan('notification:read')` (so a non-admin recipient does not yet see their targeted nudge in the
bell) — relaxing that gate + the persistent `/secrets` banner is the **frontend follow-up**.

## Related

[[0056-in-app-notification-bell]] · [[recent-activity]] · [[manual-task]] · [[access-grant]] ·
[[consumable-movement]] · [[user-keypair]] · [[0061-secret-manager-zero-knowledge]] (INV-10) ·
[[0046-roles-permissions-v2]] · [[0006-soft-delete-and-auditing]] · issue #313 · issue #453
