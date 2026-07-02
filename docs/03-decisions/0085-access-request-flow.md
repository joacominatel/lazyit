---
title: "ADR-0085: Access request flow (request → approve/deny → grant)"
tags: [adr, access, rbac, notifications, data-model]
status: accepted
created: 2026-07-02
updated: 2026-07-02
deciders: [Joaquín Minatel]
---

# ADR-0085: Access request flow (request → approve/deny → grant)

## Status

**accepted** — 2026-07-02 (issue #948). Closes the deferral explicitly recorded in
[[0023-access-management-design]] ("**[[access-request]]** — the approval workflow … deferred; a real
workflow gets its own design later"). Builds on the AccessGrant write path ([[0023-access-management-design]]),
the workflow engine's AFTER-commit decoupling ([[0054-applications-workflow-engine]]), the permission
catalog-as-code ([[0046-roles-permissions-v2]]) and the notification bell ([[0056-in-app-notification-bell]]).
This ADR is the **backend** decision; the request/approve UI is a following change (Part 2 of #948).

> **Scope.** A new append-lifecycle **`AccessRequest`** entity, its shared zod contract, the permission
> additions, four REST endpoints, and the approval that **creates the grant through the EXISTING grant
> service in one transaction** so provisioning + audit attribution keep working unchanged. NOT a general
> multi-step approval engine, NOT per-application approver chains, NOT ticketing (a non-goal, [[vision]]).

## Context

Today access is **granted directly** by an administrator ([[0023-access-management-design]]); there is no
way for an end user to **request** it. The `AccessRequest` concept has always been in the domain (build
order, the public Manual's "Access requests" page) but no surface exposed it. #948 asks for the end-to-end
flow: a user requests access to an [[application]] (optional level + justification) → admins are notified →
an approver approves (creating the [[access-grant]], recording the actor) or denies (recording a reason) →
the requester tracks the outcome.

The forces:

- **Reuse the grant path, don't fork it.** A grant created by an approval must fire the workflow engine,
  be audited and attributed exactly like a directly-created grant — otherwise approvals silently skip
  provisioning. So approval must go **through `AccessGrantsService`**, not re-implement `accessGrant.create`.
- **Atomicity.** "Create the grant" and "close the request" must not half-happen (no orphan grant with a
  still-PENDING request, no APPROVED request pointing at a rolled-back grant).
- **A request is a lifecycle row, not soft-deletable domain data.** It is born PENDING and closes by
  **decision** — the same append-only-family posture as history/ledger rows ([[0006-soft-delete-and-auditing]]).
- **One open request at a time** per (requester, application) — a user shouldn't be able to spam N pending
  requests for the same app.
- **Anyone can ask; not everyone can decide.** Requesting is self-service (even a VIEWER); deciding is the
  existing admin capability.

## Considered options

**(1) Approve = reuse the grant service vs. re-implement the grant write:**
- Re-implement the `accessGrant.create` insert inside the request service — ❌ duplicates the engine
  transactional-outbox, the actor attribution and the bell emitters; they would drift.
- **Call `AccessGrantsService`, composing the request-close into the grant's transaction (chosen)** — a new
  `createWithinApproval(data, principal, extra)` runs the full grant write path (live-checks, the engine
  outbox run, post-commit enqueue + bell) but folds a caller-supplied `extra` write (mark the request
  APPROVED with the new `grantId`) **into the same `$transaction`**. The two internal writes are atomic; the
  engine still fires AFTER commit (ADR-0054). No external call is in the tx, so same-tx is correct.

**(2) Request lifecycle — soft delete vs. decision-closes-it:**
- `deletedAt` soft delete — ❌ a request is not deletable domain data; "denied" is a *decision*, not a delete.
- **Append-lifecycle: `createdAt` only, no `updatedAt`/`deletedAt` (chosen)** — mirrors the ledger family
  ([[0006-soft-delete-and-auditing]]). The one allowed mutation (PENDING → APPROVED/DENIED) is stamped by
  `decidedAt` + `decidedById`. Rows are never deleted.

**(3) One-open-per-pair — app check vs. DB constraint:**
- Service check only — ❌ races (two concurrent creates both pass the pre-check).
- **A partial unique index `WHERE status = 'PENDING'` (chosen)** — raw SQL in the migration (Prisma PSL can't
  express it), the exact pattern of AssetAssignment's active-key and soft-delete reuse
  ([[0019-asset-assignment-integrity]]/[[0041-soft-delete-reuse-and-restore]]). A friendly up-front 409 for
  the common case; the index is the race backstop (the loser's P2002 maps to the same 409). A **decided**
  request is exempt, so the pair frees for a later request.

**(4) Deciding — a new `accessRequest:decide` verb vs. reuse `accessGrant:grant`:**
- A new decide permission — ❌ YAGNI. Deciding a request *is* granting/withholding access; the audience is
  identical (whoever may open grants). A second verb is a config-surface toggle nobody needs distinct.
- **Reuse `accessGrant:grant` (chosen)** — approve/deny gate on the existing coarse verb.

**(5) Who may request — a coarse verb vs. self-service-for-all:**
- Model `accessRequest:create` like the coarse verbs (ADMIN-only by seed) — ❌ the whole point is that a
  normal user (incl a read-only VIEWER) can ask for access.
- **A new "self-service" seed tier (chosen)** — `accessRequest:create` is seeded to **all three roles**. It
  is the first member of a new `SELF_SERVICE_CAPABILITIES` set in the catalog (the only non-`:read`/`:write`
  permission that enters the MEMBER/VIEWER default sets). Its meta tier is `edit` (a within-default mutation,
  no "above-default" ⚠ escalation marker), because granting it is never an escalation.

**(6) Decision notifications — targeted per-user vs. request list only:**
- Emit a targeted `access_request.decided` nudge to the requester — deferred. The bell is ADMIN-broadcast
  by default ([[0056-in-app-notification-bell]]); a per-user decision nudge is possible (the amendment added
  `recipientUserId`) but is UI-scope for the following change. **v1: the requester sees the outcome in their
  own request list** (`GET /access-requests/mine`).

## Decision

### 1. Data model — `AccessRequest` (append-lifecycle)

A new **`AccessRequest`** (`cuid` id, table `access_requests`):

| field | type | notes |
| --- | --- | --- |
| `requesterId` | `User` FK, `@db.Uuid`, **Restrict** | who is asking; set from the authenticated caller, never the body |
| `applicationId` | `Application` FK, **Restrict** | the target application (must be live at request time → 400) |
| `accessLevel` | `String?` | free-form, app-defined (mirrors `AccessGrant.accessLevel`); becomes the grant's level on approval |
| `justification` | `String?` | optional free text |
| `status` | `AccessRequestStatus` enum `PENDING`\|`APPROVED`\|`DENIED`, default `PENDING` | |
| `decidedById` | `User` FK, `@db.Uuid`, **SetNull** | the HUMAN approver; null while PENDING. **No SA decider column** — deciding is human-only |
| `decidedAt` | `DateTime?` | stamps the decision (the "closed at") |
| `deniedReason` | `String?` | required at deny time |
| `grantId` | `AccessGrant` FK, `@unique`, **SetNull** | the grant produced on approval (1:1); null while PENDING/DENIED |
| `createdAt` | `DateTime` | **only** timestamp — no `updatedAt`/`deletedAt` (append-lifecycle) |

Indexes: `applicationId`, `requesterId`, `status`, and the raw **partial unique**
`access_requests_requester_application_pending_key ON (requesterId, applicationId) WHERE status = 'PENDING'`.

### 2. Shared contract (`@lazyit/shared`)

`AccessRequestSchema` (wire shape), `CreateAccessRequestSchema` (`applicationId` + optional `accessLevel`/
`justification`; **no `requesterId`**), `DenyAccessRequestSchema` (**required** `reason`), the
`AccessRequestStatus` enum, and `AccessRequestListPageSchema` (the ADR-0030 page envelope). Approve carries
**no body** (the grant inherits the request's `accessLevel`).

### 3. Permissions (catalog-as-code, [[0046-roles-permissions-v2]])

- **`accessRequest:create`** — seeded to **ALL roles incl VIEWER** via the new `SELF_SERVICE_CAPABILITIES`
  set (meta tier `edit`; not an escalation). Human-only at the controller.
- **`accessRequest:read`** — pre-tightened to **ADMIN + MEMBER** (added to `VIEWER_DENIED_READS`, alongside
  `accessGrant:read`). A requester **always** reads their **own** requests via `/mine` regardless (a
  self-scope carve-out in the service, the draft-privacy pattern).
- **Deciding reuses `accessGrant:grant`** — no new verb.

Propagation to existing installs is the established mechanism (as for `import:run` / `infra:read`): the
matrix source of truth is `DEFAULT_ROLE_PERMISSIONS`; ADMIN holds the new verbs automatically (the
complete-catalog short-circuit in the resolver), and the **migrate+seed job re-runs the idempotent seed on
every deploy** (`infra/docker/migrate.Dockerfile`), upserting the new MEMBER/VIEWER default rows. No
per-permission data migration.

### 4. Endpoints (`/access-requests`)

- `POST /access-requests` — **`accessRequest:create`**, human-only (`ServicePrincipalForbiddenGuard`).
  Requester = the caller. 400 if the app isn't live; **409** if a PENDING request for it already exists.
- `GET /access-requests` — **`accessRequest:read`**; filters `status`/`applicationId`/`requesterId`; paged.
- `GET /access-requests/mine` — **any authenticated human** (no `accessRequest:read`); the caller's own
  requests, paged (self-scope carve-out).
- `POST /access-requests/:id/approve` — **`accessGrant:grant`**, human-only. Creates the grant + flips the
  request to APPROVED **in one transaction** via `AccessGrantsService.createWithinApproval`. 409 if already
  decided (checked, and a guarded `updateMany WHERE status='PENDING'` rolls back the grant on a raced flip).
- `POST /access-requests/:id/deny` — **`accessGrant:grant`**, human-only; **requires a reason**. 409 if
  already decided.

### 5. Notifications ([[0056-in-app-notification-bell]])

On **create**, a best-effort POST-COMMIT broadcast nudge — new closed type **`access_request.created`**,
`dedupeKey = access_request.created:<requestId>`, `entityType: application` / `entityId: applicationId`
deep-link, `targetUserId: requesterId`, REDACTED metadata (requester + app names/ids). It lands in the admin
feed (the `notification:read` holders — by default the ADMIN cohort that also holds `accessGrant:grant`).
The web bell's exhaustive `TYPE_META` gains one entry (the standard catalog-as-code tax). **On decision, no
user-facing notification in v1** — the bell is ADMIN-broadcast, so the requester tracks the outcome in their
own request list (a targeted decision nudge is a documented follow-up).

## Consequences

- **Positive:** the deferred approval flow lands **without changing the grant model** — approvals produce an
  ordinary auditable [[access-grant]] that fires the engine exactly as a direct grant does; the request row
  is an immutable-lifecycle record; self-service requesting is open to every role while deciding stays an
  admin capability; one-open-per-pair is race-safe by DB construction; the grant service gains **one** small,
  well-scoped composition method (`createWithinApproval`) rather than a fork.
- **Negative / trade-offs (accepted):**
  - **A new model + migration + module** and **two catalog permissions** (the golden-matrix + covering-set
    tests + the web `TYPE_META`/exhaustive-map re-typecheck — the standard catalog-as-code cost).
  - **A new seed tier (`SELF_SERVICE_CAPABILITIES`)** — the first permission a VIEWER holds that isn't a
    `:read`. Documented and pinned by the golden tests; it deliberately carries **no** above-default warning.
  - **No decision notification in v1** — a requester must open their request list to see approve/deny.
    Acceptable (the bell is admin-only); a targeted nudge is a clean additive follow-up.
  - **Deciding is human-only** — there is no service-account decider column (a decision needs a human actor).
    A future SA-decider would need a `decidedBySaId` column, mirroring the grant's dual actor.
- **Follow-ups:** the request/approve **UI** (Part 2 of #948) — a "Request access" action on application
  detail, an admin decision surface, the requester's tracking view, and the role-aware empty-state copy;
  the **public Manual** page (`applications-access-requests`, en+es) updated from "coming" to the real flow
  **in that UI change** (it is user-facing only once the UI exists); optionally a targeted
  `access_request.decided` bell nudge to the requester.

Related: #948 · [[0023-access-management-design]] · [[0054-applications-workflow-engine]] ·
[[0056-in-app-notification-bell]] · [[0046-roles-permissions-v2]] · [[0019-asset-assignment-integrity]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[access-request]] · [[access-grant]] · [[application]] · [[user]] · [[prisma-migrations]]
