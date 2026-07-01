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

## Amendment (2026-06-14) — targeted per-user notifications + the vault-setup nudge (issue #453)

**Status: accepted (CEO sign-off 2026-06-14)** — verbatim: *"Sí, apruebo + banner ya."* This amendment
is an **auth-contract change to the notification model** — flag it as such. v1 of this ADR was
**broadcast-to-admins-only**: a `Notification` is fanned out on read to **every holder of
`notification:read`** (seeded ADMIN-only, §6), and `@RequirePermission('notification:read')` gates all
four endpoints (`apps/api/src/notifications/notifications.controller.ts`). There was **no way to deliver a
notification to a specific user** — and crucially **no way for a non-admin to see the bell at all**. This
amendment adds **targeted per-user delivery** without widening the admin broadcast set.

### A. `recipientUserId` — who SEES it, distinct from `targetUserId` (who it's ABOUT)

- A `Notification` gains a **`recipientUserId`** — the user who should **see** this notification in
  **their** bell. It is **distinct from** the existing **`targetUserId`** (the *subject* of the event —
  the grantee / elevated user a broadcast is *about*; see the live schema `model Notification` and
  `notifications.service.ts`). The two answer different questions: `targetUserId` = "who is this event
  about?", `recipientUserId` = "whose bell does this land in?". A row may carry one, both, or (for the
  existing admin broadcasts) neither.
- **Delivery semantics, additively:**
  - `recipientUserId == null` → the existing **admin broadcast** behaviour, unchanged: visible to every
    `notification:read` holder via the fan-out-on-read audience (§1).
  - `recipientUserId == U` → a **targeted** notification visible to **U** in U's own bell — **even when U
    is not an admin** and holds no `notification:read` over the broadcast set.
- **Auth-contract change (the sharp part).** A non-admin recipient can now see the bell **for their OWN
  targeted notifications only**, *without* gaining `notification:read` over the admin broadcast set. The
  read endpoints must therefore resolve, per caller:
  1. the caller's **own targeted** notifications (`recipientUserId == caller`) — always visible to the
     recipient, **regardless of `notification:read`**; and
  2. the **broadcast** set (`recipientUserId == null`) — visible **only if** the caller holds
     `notification:read` (ADMIN-only by default, §6).
  This is a deliberate, bounded relaxation of the v1 "the bell is ADMIN-only" gate: a non-admin sees a
  **strict subset** scoped to rows explicitly addressed to them, and **never** the admin broadcast feed.
  It does **not** add a new permission and does **not** grant `notification:read`; it scopes visibility by
  **ownership of the row**, the same "you see your own" shape as `GET /users/me`. The
  `notifications.controller.ts` per-endpoint gate and the `requireHumanId` human-only resolution are
  updated accordingly (a recipient is, by construction, a human user). Service-account principals remain
  excluded (no per-user bell state).

> **Bell-UI relaxation (frontend, 2026-06-14).** §8 originally **hid the bell entirely** for non-admins
> (it self-gated on `useCan('notification:read')`, returning `null`). With targeted delivery landed, that
> hiding would suppress a non-admin recipient's **own** nudge. The frontend now **renders the bell for
> every authenticated human** and no longer self-gates on `notification:read`; visibility is scoped
> **server-side** per recipient (own targeted rows always; the broadcast set only with `notification:read`)
> — the API is the real gate, the client gate is removed (defense-in-depth was a 403-avoidance nicety, now
> moot since the endpoints are open to any authenticated human and scope per caller). The unread badge
> polls always (a cheap, per-caller COUNT); the heavier list still polls only while the popover is open. A
> user with zero notifications sees a clean bell with no badge. Backend in PR #468; frontend catch-up under
> #453.

### B. First trigger — the vault-setup nudge at login

The first targeted notification:

- **Condition:** at login, a user who **holds `secret:read`** ([[0061-secret-manager-zero-knowledge]] §7
  / [[0046-roles-permissions-v2]]) **but has no `UserKeypair`** (they have never set a vault passphrase,
  so they cannot decrypt any vault) gets a **one-time targeted** notification — `recipientUserId = that
  user` — copy *"set up your vault passphrase"*, deep-linking to `/secrets`.
- **Idempotent** via the existing dedupe mechanism (§4): **`dedupeKey = secret.vault_setup:<userId>`**.
  Because `dedupeKey` is `@unique` on `Notification` (live schema), the emit **never re-fires** — a user
  who logs in ten times before setting up their vault gets **exactly one** vault-setup notification, and
  none after they create their `UserKeypair`. This is the same "the emitter is best-effort, so it must be
  safe to fire twice" posture as §4. A new closed `NotificationType` literal (e.g. `secret.vault_setup`)
  is added to the shared enum (§5) — the standard additive catalog-as-code change, with the golden-test
  update + **web exhaustive-map re-typecheck** the §6 discipline already requires.
- This nudge respects **INV-10** ([[0061-secret-manager-zero-knowledge]]): it carries **no secret value,
  no key material** — only the metadata "you have not set up your vault" and a link. The server learns
  nothing zero-knowledge (it already knows whether a `UserKeypair` row exists — that is non-secret
  metadata, §9 of ADR-0061).

### C. The `/secrets` banner — DROPPED (CEO decision, 2026-06-14)

> **Update (2026-06-14) — Section C is intentionally NOT shipped.** Per a later CEO call the same day
> (*"solo la campana"*), the standalone `/secrets` page banner is **dropped**. Two reasons make it
> redundant: (1) the **bell is now rendered for every authenticated human** (see the bell-UI note below),
> so the vault-setup nudge is discoverable from **any** page, not only `/secrets`; and (2) the `/secrets`
> page already renders the keypair **bootstrap form** as the on-page CTA for the **exact same population**
> (`secret:read` ∧ no `UserKeypair`), so a separate banner would just duplicate that prompt. The targeted
> notification (A + B) — the real build behind this amendment — stands and is unaffected. The original
> banner proposal is kept below for the record.

The CEO's *"+ banner ya"*: ship **immediately** a **`/secrets` page banner** for the **same condition**
(`secret:read` ∧ no `UserKeypair`) prompting "set up your vault passphrase". The banner is a **client-side
gate** the `/secrets` page can render today from already-available signals (the caller's permissions via
`useCan('secret:read')` + whether their keypair exists) — it does **not** depend on the targeted-
notification wiring. The **targeted notification (A+B) is the build behind this ADR**; the banner is the
immediate, independently-deliverable surface so the prompt exists from day one while the bell wiring lands.

### Amendment consequences

- **Positive:** the bell becomes a **per-user delivery** surface, not just an admin broadcast — a user can
  be nudged in their **own** bell without being made an admin; the vault-setup gap (a `secret:read` holder
  who never set a passphrase, and so silently can't decrypt anything) is closed with an idempotent,
  INV-10-safe nudge; the banner ships immediately, decoupled from the wiring.
- **Negative / trade-offs (accepted):** a **second visibility axis** on the bell (broadcast vs targeted)
  and the per-caller read resolution that splits "my targeted rows (always)" from "the broadcast set (if
  `notification:read`)" — more read logic, but a *narrowing* (a non-admin sees strictly less, scoped to
  their own rows), never a widening of the admin feed. The auth-contract change is **explicitly flagged**
  here and must be covered by the authz tests (`notifications.authz.spec.ts`): a non-admin sees **their
  own** targeted notification and **never** a broadcast one.
- **Follow-ups:** the `recipientUserId` column + migration (FK to `User`, `@db.Uuid`, `SetNull` — same
  shape as `targetUserId`); the per-caller read-resolution change in `notifications.service.ts` /
  `notifications.controller.ts` (own-targeted-always + broadcast-if-permitted) + authz tests; the
  login-time vault-setup emitter (dedupeKey `secret.vault_setup:<userId>`, fired post-auth, best-effort,
  no-op once a `UserKeypair` exists); the new `secret.vault_setup` `NotificationType` literal + golden
  test + web re-typecheck; the `/secrets` banner (now-deliverable, independent of the wiring).

### FK refinement (2026-06-16) — `recipientUserId` is `onDelete: Cascade`, not `SetNull` (issue #470)

The amendment shipped `recipientUserId` with **`onDelete: SetNull`**, copying `targetUserId`'s shape. A
lazyit-sentinel review of PR #468 flagged the subtle consequence (issue #470): the targeted-vs-broadcast
visibility scope (§A) reads `recipientUserId == null` as a **broadcast** to every `notification:read`
holder. So if a user who received a **targeted** notification were ever **hard-deleted**, `SetNull` would
flip `recipientUserId → NULL` and silently **promote** that private nudge into the admin broadcast feed —
exactly the wrong default for a row that was scoped to one person.

**Resolved by `onDelete: Cascade`** (migration `…_notification_recipient_user_fk_cascade`, one
`ALTER … ON DELETE CASCADE` on the FK, nothing else): a targeted notification whose recipient is
hard-deleted **has no audience, so it is DROPPED** — never broadcast. This is the right semantic for the
*recipient* axis and is **defense-in-depth**: real user removal is **soft-delete** (the row persists, the
FK never fires), and the only hard-delete paths (`users.service.ts` `compensateLocalCreate`,
`config.service.ts` setup rollback) delete a *just-created* user with zero notification history. The
notification copy also carries no secrets (INV-6 / INV-10), so this was latent, not reachable today — but
the FK now encodes the correct intent rather than relying on that. The two FKs are intentionally
**different**: `targetUserId` stays `SetNull` (the event survives the loss of the person it was *about*);
`recipientUserId` is `Cascade` (the event has no reason to exist once the person it was *for* is gone).

## Amendment (2026-06-30) — sensitive-audit + agent-liveness alerts (issue #852)

**Status: accepted.** Two new **broadcast** notification types extend the curated catalog (§5) so the
bell carries a tight, on-positioning **security signal** for a single-org IT team — NOT a SIEM, NOT a
rules engine, NOT configurable retention. Both are `recipientUserId == null` broadcasts, so they land
in the existing admin feed (every `notification:read` holder — ADMIN-only by default, §6), which is the
right audience for sensitive operational state. Reuses `NotificationsService.emit` unchanged; adds **no**
queue, DSL or config.

### A. The two new types (additive, closed-enum change)

- **`permission_widened`** — emitted **post-commit, best-effort** from `PermissionsConfigService.updateMatrix`
  ([[0046-roles-permissions-v2]] P5) when a `PUT /config/permissions` edit **GRANTED** MEMBER or VIEWER a
  **high-risk verb**: `settings:manage`, `user:manage`, `accessGrant:grant`, or **any `:delete`**. ONE nudge
  per edit (folds every widened verb across both roles), `severity: warning`, redacted metadata (role + verb
  literals + actorId). Dedupe `permission_widened:<actorId>:<emit-instant>` — a matrix PUT is not
  infra-retried and a re-run diffs to an **empty** grant set, so the key never suppresses a real event.
  Deep-links (by type) to the role→permission editor. **ponytail:** there is **no "self-escalation" axis to
  distinguish** here — only an ADMIN (`settings:manage`) may edit the matrix, ADMIN is immutable/full
  (INV-8), and edits target the MEMBER/VIEWER **role** sets, never the actor's own account, so an admin can
  never widen *themselves*. Ceiling: revisit only if per-user permission overrides ever land (#615).
- **`infra.agent_offline`** — emitted from `InfraAgentStalenessSweeper.sweep` ([[0074-server-reporting-agent]]
  §4) for each node **transitioning** CONFIRMED→OFFLINE. The bulk `updateMany` can't say which rows it
  flipped, so the sweep **snapshots the `status != OFFLINE` doomed set** (a `findMany` on the same predicate)
  *before* the flip and emits one nudge per snapshot node, `severity: warning`, metadata = nodeId + label +
  last-report time. Dedupe `infra.agent_offline:<nodeId>:<lastReportedAt>` → **one nudge per outage** (a node
  stuck OFFLINE is not re-selected next sweep; a genuinely new outage has a fresh last-report instant ⇒ a
  fresh key ⇒ a fresh nudge), never once-per-sweep. Deep-links (by type) to the topology map. **ponytail:**
  emitting for the snapshot set, not the exact flipped rows — a node that reports in between the two queries
  is excluded from the flip yet may still get one nudge (a tiny two-query race, deduped, on a small cohort).
  Ceiling: the exact flipped set would need a `RETURNING` clause (raw SQL) or a per-node update.

Both are additive closed-enum literals (§5): the golden shared test asserts them, and — because the web bell's
`TYPE_META` is an **exhaustive `Record<NotificationType, …>`** that CI type-checks — each new literal needs a
`TYPE_META` entry (icon + tone + by-type deep-link) or `apps/web` fails to compile. That one-entry-per-type
cost is the standard catalog-as-code tax (§6), not scope creep into web app logic.

### B. Deferred — repeated secret-decrypt / vault-access failure alert

Issue #852 also floated an alert on **repeated secret-decrypt failures**. It is **deferred**, not built,
because it is not cheaply/unambiguously detectable today: the Secret Manager is **zero-knowledge (INV-10,
[[0061-secret-manager-zero-knowledge]])** — the server **never** receives a passphrase and **never** performs
a decrypt, so a genuine "failed decrypt" (a wrong passphrase, unwrapping the private key browser-side) is
**structurally invisible** server-side. The only server-observable signal is scattered **authorization
denials** (`ForbiddenException` on non-membership across several service methods), a *different* signal with
real false-positive risk (a user clicking a vault they aren't a member of ≠ an attack) that would need new
plumbing — an attempt counter or failure-audit rows — **and a product call** on what counts as "suspicious".
Rather than force an ambiguous proxy, we shipped `permission_widened` + `infra.agent_offline` and left the
secret-failure alert for its own small design.

Related: #852 · #615 (per-user overrides — the only thing that would add a "self-escalation" axis) ·
[[0074-server-reporting-agent]] (the staleness sweeper) · [[0061-secret-manager-zero-knowledge]] (INV-10 —
why the secret-failure alert is deferred) ·

Related: #313 · #248 · #453 · #470 · [[0054-applications-workflow-engine]] · [[0048-service-accounts]] ·
[[0046-roles-permissions-v2]] · [[0044-recent-activity-view]] · [[0034-consumables-design]] ·
[[0033-asset-history-event-model]] · [[0031-logging-strategy]] · [[0030-list-pagination-contract]] ·
[[0023-access-management-design]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[0061-secret-manager-zero-knowledge]] (INV-10 — the vault-setup nudge condition) · [[INVARIANTS]] (INV-10) ·
`docs/workflow-engine/frontend.md` (§6a)
