---
title: "ADR-0056: In-app notification bell — append-only Notification + per-admin read state (admin-only, v1)"
tags: [adr, notifications, frontend, rbac, workflow-engine, data-model]
status: accepted
created: 2026-06-09
deciders: [Joaquín Minatel]
---

# ADR-0056: In-app notification bell — append-only Notification + per-admin read state (admin-only, v1)

## Status

**accepted** — 2026-06-09. The CEO **greenlit building it** (issue #313). This is the real decision for
the topbar notification bell that the workflow-engine frontend design assumed already existed
(`docs/workflow-engine/frontend.md` §6a "ride the notification bell" — that note pointed at a
Settings/Notifications branch that **never landed on `dev`**; this ADR replaces that dangling
dependency with a concrete, self-contained model). It mirrors the immutable-event precedent of
[[0033-asset-history-event-model]] / [[0034-consumables-design]] and the access ledger
([[0023-access-management-design]]), reuses the at-most-one-actor / `ActorService` pattern
([[0048-service-accounts]]), extends the frozen permission catalog ([[0046-roles-permissions-v2]]), and
is deliberately **distinct from** the derived `recent_activity` dashboard view
([[0044-recent-activity-view]]).

> **Scope of this ADR.** A new **append-only `Notification`** model + a **per-admin `NotificationRead`**
> join (fan-out-on-read), a small **closed shared enum** of notification types, **best-effort
> post-commit** emitters on existing write paths, a **poll** delivery API (SSE is a documented Phase-2
> upgrade behind the *same* API), and a new **`notification:read`** permission seeded **ADMIN-only**. The
> topbar bell is gated on it. Notifications are **operational nudges, not the audit system-of-record** —
> history tables and ledgers remain that.

## Context

Two needs converge on one bell:

- **The workflow engine needs a human nudge.** A `ManualTask` ("which team? — please complete by hand")
  and a `workflow.run_failed` alert are exactly "something needs a human / went wrong" events
  (ADR-0054 §8; `docs/workflow-engine/frontend.md` §6a / §6b). The engine design *assumed* a bell + SSE
  stack from a Settings/Notifications branch, flagged as dependency **D1** and explicitly noted as **not
  on `dev`**. That branch never merged, so the assumed substrate does not exist. The engine currently
  degrades to a polled inbox page; the CEO wants the actual bell.
- **A handful of operationally-important events deserve a curated nudge**, beyond the workflow engine:
  access to a **critical application** was granted, an **ADMIN role** was granted to a user, a
  **consumable crossed below its minimum stock**. These are the "an admin should glance at this" events —
  a small, deliberate, curated trigger set, **not** a firehose.

The existing dashboard recent-activity feed ([[0044-recent-activity-view]]) is **not** the right
substrate for this:

- It is a **derived `UNION ALL` Postgres VIEW** over four append-only tables, whose row shape is
  `{ occurredAt, actorId?, entityType, entityId text, action, summary }` — there is **no stable
  per-row id** (the `entityId` is the *source entity's* id, not a notification id, and it is not unique
  across the union). Per-item "mark this read" is therefore **impossible** against the view.
- It is **too coarse** — it surfaces *every* state change across the estate, the opposite of a curated,
  small set of "an admin should look" triggers.

So the bell needs its **own** durable, per-row-addressable, curated store.

## Considered options

### Storage / fan-out model

- **An append-only `Notification` + a per-admin `NotificationRead` join — fan-out-on-READ (chosen).**
  One immutable row per *event*; read state is a separate per-(admin, notification) row written lazily
  when an admin marks it read. Mirrors the `AssetHistory` / `AccessGrant` immutable-event precedent
  ([[0033-asset-history-event-model]] / [[0023-access-management-design]]): the event is written once,
  the audience derives its per-admin read state on the side. With a small admin cohort (5–20 people,
  ADMIN-only) this is cheap and clean, and "unread count" is one anti-join.
- **Fan-out-on-WRITE (one row per admin per event) — rejected.** Row explosion (every event × every
  admin) for a feature whose whole point is a handful of curated events, and a **stale audience**: an
  admin added after an event would not see it, an admin removed would keep dead rows. Fan-out-on-read
  computes the audience at read time, so it is always current.
- **A hybrid "derive the feed + a per-admin read cursor" — rejected.** A single "everything before
  timestamp T is read" cursor gives a cheap unread *count* but **cannot express per-item read** ("I read
  this one, not that one"), which the bell's mark-one-read UX requires.
- **Pure-derive from `recent_activity` — rejected (technically blocked).** No stable per-row id ⇒ no
  per-item read state, and the view is too coarse for curated triggers (see Context).

### Delivery

- **Poll in v1; SSE as a Phase-2 upgrade behind the SAME API (chosen).** `GET /notifications` +
  `GET /notifications/unread-count` are the dependency-free floor (works on any substrate, no new
  transport, no Valkey pub/sub). SSE push is a clean, additive upgrade *behind the same endpoints* — the
  frontend contract does not change when it lands. The Valkey pub/sub fanout the engine docs sketched is
  **deferred**; polling a small admin cohort is entirely adequate for v1.
- **SSE-first — rejected for v1.** Needs the pub/sub fanout plumbing up front; polling defers it cleanly
  with no contract churn. `docs/workflow-engine/frontend.md` already treats polling as the floor and SSE
  as the live upgrade.

## Decision

Ship a self-contained notification model with poll delivery, ADMIN-only, fan-out-on-read.

### 1. Data model — append-only `Notification` + per-admin `NotificationRead`

- **`Notification`** — **append-only** (per [[0006-soft-delete-and-auditing]]: `createdAt` only, **no**
  `updatedAt` / `deletedAt`), `cuid()` id. Columns: a **`type`** (the closed shared enum, §5), a
  human-facing `title` / `summary`, a nullable **`entityType` / `entityId`** deep-link target (the app,
  user, consumable or run the nudge is about), optional small redacted `metadata` jsonb (names/ids only,
  never bodies/secrets — INV-6, [[0031-logging-strategy]]), and a **`dedupeKey`** (§4). The row is the
  *event*; it is never mutated.
- **`NotificationRead`** — the per-admin read join: `{ notificationId, userId, readAt }`, **unique on
  `(notificationId, userId)`**, written lazily the first time an admin marks the notification read.
  Absence of a row = unread for that admin. `cuid()` / append-then-touch; `readAt` is the only mutable
  field. FK to `Notification` is **Restrict** (an event with read history is not hard-deletable; the
  retention sweep, §7, is the only deleter), to `User` is **Cascade-on-the-join** semantics handled like
  other actor joins (losing a user drops only that user's read rows, never the event).

"Unread for admin A" = a `Notification` with no `NotificationRead` row for A (subject to retention).
Unread count is one anti-join over the small admin cohort.

### 2. Delivery API — poll in v1

- `GET /notifications` — the admin's notification list (newest-first, paginated per
  [[0030-list-pagination-contract]]), each item carrying its per-caller `read` flag.
- `GET /notifications/unread-count` — the badge number (the anti-join).
- `PATCH /notifications/:id/read` — mark one read (upsert the `NotificationRead` row).
- `PATCH /notifications/read-all` — mark all the caller's currently-unread notifications read.

**SSE is a Phase-2 upgrade behind the *same* API** — when it lands it pushes the same notification
shapes over a stream; the list/count endpoints and the wire types are unchanged. No contract churn.

### 3. Emitters — best-effort, POST-COMMIT side-effects on existing write paths

Notifications are emitted **after** the originating transaction commits, **best-effort** (a failed emit
**never** rolls back or blocks the domain write — the same decoupling discipline as ADR-0054 §1 for the
grant). The v1 triggers, each on an existing write path:

- **`AccessGrant.create`** → if `application.isCritical` (reusing the existing
  `Application.isCritical` boolean — **no schema change**, confirmed at `apps/api/prisma/schema.prisma`
  `model Application`) emit **`critical_app_access`**; if the grant raises a user to the **ADMIN** role,
  emit **`admin_granted`**. (Access to critical apps + admin elevation are the sensitive events
  ADR-0046's read-tightening already treats as worth guarding.) The **user-clone** path
  ([[0058-user-manager-and-clone-actions]] §4), which writes its grants directly to govern the engine
  toggle, **reuses this same emitter** post-commit for every cloned grant (issue #359) — so a clone is
  never silent on the bell, independent of whether the clone's engine toggle fired the workflow.
- **`Consumable.createMovement`** → on a transition **from above-threshold to at/below `minStock`** emit
  **`low_stock`**, **DEDUPED** (§4) so a consumable flapping around its threshold does not spam the bell.
  (Stock is the cached value + append-only movements model of [[0034-consumables-design]].)
- **`ManualTask` creation** (workflow engine) → emit **`workflow.manual_task`**; a failed run that
  escalates/stops emits **`workflow.run_failed`** (ADR-0054 §8). These are the engine's §6a nudges, now
  with a real bell instead of a dangling dependency.

### 4. Idempotent emitters via a dedupe key

A **`dedupeKey`** of `(type, entityId)` (plus, where relevant, a coarse time bucket for `low_stock`)
makes emitters **idempotent**: re-running a write path (a retry, a flapping consumable, a re-fired
listener) collapses to **one** notification per logical event. This is the same "the emitter is
best-effort, so it must be safe to fire twice" posture the engine's idempotency rule takes (ADR-0054
§3).

### 5. Notification type — a CLOSED shared enum (catalog-as-code)

The notification `type` is a **closed `z.enum`** in `@lazyit/shared` (the catalog-as-code instinct of
[[0046-roles-permissions-v2]]) — `critical_app_access`, `admin_granted`, `low_stock`,
`workflow.manual_task`, `workflow.run_failed` for v1. A typo can't mint a type; CI fails on an unknown
literal; `api` (emit) and `web` (render) agree by construction, and the bell can render a closed set of
icons/copy. Adding a type later is an additive shared-package change.

### 6. RBAC — a new `notification:read`, seeded ADMIN-only

A new **`notification:read`** permission is added to the frozen catalog
(`packages/shared/src/schemas/permission.ts`) and seeded **ADMIN-only** by listing it in
**`ADMIN_ONLY_READS`**, exactly like `logs:read` / `workflow:read` (it is excluded from the default
MEMBER and VIEWER seed sets; still admin-grantable from the role matrix). Notifications surface
sensitive operational state (who got critical-app access, who was made ADMIN), so admin-only is the safe
default. **This is a catalog-as-code change** — adding the literal requires the golden-test update **and
a web `tsc` pass against the exhaustive permission maps** (project memory:
`shared-changes-need-web-typecheck`; the same care ADR-0054's `workflow:*` additions needed).

### 7. Per-item + mark-all read; 90-day retention

- **Mark-as-read** is `NotificationRead.readAt`, set via the `PATCH` endpoints (§2) — per-item or
  mark-all. Completing/dismissing a workflow manual task marks its originating
  `workflow.manual_task` notification read, so the bell stays in sync with the inbox.
- **Retention: a 90-day sweep** prunes old notifications (and their read joins). Notifications are
  **operational nudges, not the audit system-of-record** — the append-only history tables and ledgers
  ([[0033-asset-history-event-model]] / [[0034-consumables-design]] / [[0023-access-management-design]] /
  the workflow run ledger) remain the durable record. The bell is allowed to forget; the ledgers are
  not.

### 8. Frontend — the topbar bell, gated by `notification:read`

The bell slots into `apps/web/app/(app)/layout.tsx`, **gated by `useCan('notification:read')`** (the
existing client permission hook). The dropdown **reuses the activity-row visual grammar** of the
dashboard recent-activity feed (icon + actor + summary + relative time + deep-link), so it reads as one
visual family with the rest of the app — but it is backed by the **`Notification` store, not the
`recent_activity` view** (§Context: the view can't address a row). Each row deep-links to its
`entityType`/`entityId` target; the manual-task type links to the workflow inbox
(`docs/workflow-engine/frontend.md` §6a). When SSE lands (Phase 2), the bell pushes live behind the same
contract — the component does not change shape.

## Consequences

- **Positive:**
  - One curated, per-row-addressable nudge surface that the workflow engine, access and consumables all
    feed — replacing the engine's dangling "ride the notifications branch" dependency with a concrete,
    self-contained model on `dev`.
  - **Fan-out-on-read** keeps storage proportional to *events*, not events × admins, and the audience is
    always current (no stale rows when admins are added/removed) — the right fit for a small ADMIN
    cohort.
  - The notification store is **distinct from** the audit ledgers: the bell can forget (90-day
    retention) without touching the immutable system-of-record, preserving auditability-by-default.
  - Poll-now / SSE-later **behind one API** means no contract churn when realtime lands; v1 needs **no
    new realtime infrastructure** (no Valkey pub/sub fanout).
  - Reuses what exists: `Application.isCritical` (no schema change for the critical-app trigger), the
    `ActorService` attribution pattern, the catalog-as-code permission discipline, and the
    activity-row visual grammar.
- **Negative / trade-offs (accepted):**
  - **A new model + migration + a `NotificationsModule`** and **one shared-permission addition** — the
    permission addition forces a **web `tsc` pass** for the exhaustive permission maps (accepted, the
    standard catalog-as-code cost).
  - **Best-effort post-commit emitters** mean a crashed process between commit and emit can drop a
    *notification* (never the domain write, never the audit row). Accepted: the bell is a nudge, not the
    record; the ledgers and the workflow run sweeper are the durable truth.
  - **Polling latency** until SSE lands — acceptable for a curated, low-volume, ADMIN-only feed.
  - **Retention forgets old notifications** by design — acceptable precisely because the bell is *not*
    the audit system-of-record.
- **Follow-ups:** the `Notification` + `NotificationRead` Prisma models + migration; the
  `NotificationsModule` (the four poll endpoints) with `@RequirePermission('notification:read')`; the
  `notification:read` catalog literal + `ADMIN_ONLY_READS` entry + golden test + **web exhaustive-map
  re-typecheck**; the closed `NotificationType` shared enum; the post-commit emitters wired into
  `access-grants.service`, `consumables` movement creation and `ManualTask` creation (with the no-block
  invariant); the dedupe-key logic; the 90-day retention sweep; the topbar bell component gated by
  `useCan('notification:read')`. **Phase 2:** SSE push behind the same API (the deferred Valkey pub/sub
  fanout), upgrading the bell to live without a contract change.

Related: #313 · #248 · [[0054-applications-workflow-engine]] · [[0048-service-accounts]] ·
[[0046-roles-permissions-v2]] · [[0044-recent-activity-view]] · [[0034-consumables-design]] ·
[[0033-asset-history-event-model]] · [[0031-logging-strategy]] · [[0030-list-pagination-contract]] ·
[[0023-access-management-design]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
`docs/workflow-engine/frontend.md` (§6a)
