---
title: AccessGrant
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-10-22
---

# AccessGrant

> 🟢 implemented · Area: Access · Implementation order: 5

## Purpose

The timestamped join recording that a [[user]] has access to an [[application]], over time — the
answer to "**who can access what?**". Like [[asset-assignment]], it carries lifecycle timestamps so
granting and (critically for offboarding) **revoking** access is auditable ([[problem-space]]). See
[[0023-access-management-design]].

## Relationships

- **belongs to** one [[user]] — the grantee (`userId`, **required** FK, `onDelete: Restrict`).
- **belongs to** one [[application]] (`applicationId`, **required** FK, `onDelete: Restrict`).
- **optionally references** a [[user]] as `grantedBy` and/or `revokedBy` — audit of who acted
  (`onDelete: SetNull`; `null` when the system acted or it's unknown).
- **may be produced by** an approved [[access-request]] — the approval creates the grant through the
  same write path (in one transaction) and back-links it via `AccessRequest.grantId`
  ([[0085-access-request-flow]]). A directly-created grant has no such request.

## Business rules

- **Append-only lifecycle join** ([[0006-soft-delete-and-auditing]]): rows are **never deleted**. A
  grant with `revokedAt = null` is *active*; setting `revokedAt` ends it without losing the record.
  There is **no `DELETE` endpoint** — revoke instead.
- **Multi-grant (no uniqueness constraint):** a user may hold **several active grants** on the same
  application at different `accessLevel`s (e.g. `admin` on the console + `readonly` on the API).
  This deliberately **contrasts [[asset-assignment]]**, which forbids duplicate active rows via a
  partial unique index — access has no such rule ([[0023-access-management-design]]).
- **`accessLevel` is free-form**, app-defined (`admin`, `developer`, `viewer`, …). lazyit stores it
  verbatim and never interprets it; each [[application]] owns its vocabulary.
- **`expiresAt` drives auto-revoke** — a periodic sweeper (`AccessGrantExpirySweeper`) revokes a grant
  once it passes `expiresAt`, through the normal `revoke()` path so the deprovision workflow + system
  attribution fire ([[0023-access-management-design]] amended). It is not informative: a past expiry,
  typed on create or set by an edit, is revoked on the next sweep. A proactive **`access_grant_expiring`**
  notification (bell + email, admin broadcast) warns ~14 days before, so the team can re-grant before a
  contractor/temp silently loses access (#1070). It is skipped when the grant's application or user is
  soft-deleted. On **create**, when both are supplied, `expiresAt` must
  be **on or after** `grantedAt` (a grant can't expire before it starts) — a `@lazyit/shared` cross-field
  refine returns `400` otherwise (round-2 correctness). **Changing the expiry** enforces the same rule
  against the stored `grantedAt` in the service → `400` (AUD-097). Write-only: an existing row whose
  expiry already predates its `grantedAt` still reads normally.
- **Revoke happens once:** the revoke write is conditional on `revokedAt = null`. When two revokes
  race (an admin and the expiry sweeper, or two admins), the first one wins and keeps its
  `revokedAt` / actor attribution; the other gets `409` (single) or `already_in_state` (batch) and
  records no second deprovision run (AUD-043).
- **Immutable identity:** `userId`, `applicationId` and `grantedAt` are set once. Only `notes`,
  `revokedAt` and `expiresAt` are mutable.
- **Create-time integrity:** `userId` and `applicationId` must reference **live** (non-soft-deleted)
  rows, or the API returns `400` — don't grant access to a decommissioned app or a departed user.
  The person must also be **active**: a deactivated person (`isActive = false`) cannot sign in, so
  a grant to them is refused with `400 ACCESS_GRANT_PERSON_INACTIVE` (#1661). The check lives in the
  one grant write path, so it covers `POST /access-grants` **and** every [[access-request]] approval,
  self-filed or filed on someone's behalf — a request filed while the person was active and approved
  after they were deactivated is refused and stays `PENDING`. A directory-only person is refused too
  (they have no account).
- **Referential integrity:** the required FKs are `onDelete: Restrict` — a [[user]] or
  [[application]] with grant rows **cannot be hard-deleted**.

> [!note] Actor comes from the authenticated principal, not the body
> The create and revoke actor is the verified principal ([[0038-jit-user-provisioning]],
> [[0048-service-accounts]]), **never** the request body ([[0023-access-management-design]]): a human
> lands in `grantedById` / `revokedById`, a service account in `grantedBySaId` / `revokedBySaId`. No
> principal → `null` actor (system/unknown), allowed by the `SetNull`/optional design. The `X-User-Id`
> shim is only a dev-mode way to supply that principal ([[0022-draft-visibility-auth-shim]]).
> [[asset-assignment]] follows the **same** pattern ([[0024-asset-assignment-actor-shim]]), so both
> append-only joins agree.

> [!warning] Soft delete vs hard delete — `Restrict` is a DB safety net
> The API's `DELETE /applications/:id` and `DELETE /users/:id` are **soft** deletes
> (`UPDATE deletedAt`), so they are **not** blocked by `Restrict` — that guard only fires on a real
> row `DELETE` (→ `P2003`/`400`). So an app/user *can* be soft-deleted while it has active grants;
> the create-time live-check reduces, but doesn't eliminate, dangling references. Same nuance as
> [[asset-assignment]] ([[0019-asset-assignment-integrity]], [[0023-access-management-design]]).

> [!note] Access-grant writes need `accessGrant:grant`; reads need `accessGrant:read` (the read map tightened)
> All grant writes — `POST /access-grants` (open), `PATCH /access-grants/:id/revoke`, `…/notes`,
> `…/expiry`, and the batch revoke — are gated `@RequirePermission('accessGrant:grant')`
> ([[0046-roles-permissions-v2]]) — ADMIN-only in the seed; **never** `accessGrant:write` (a MEMBER
> holds that as an intentional orphan slot, so using it would have silently handed MEMBER an ADMIN-only
> Access write). The single `@RequirePermission` primitive replaced the retired `@Roles('ADMIN')` gate
> (behavior-preserving, parity-tested).
>
> **The read map is now tightened.** `GET /access-grants` and the nested reads are gated
> `@RequirePermission('accessGrant:read')` — ADMIN + MEMBER only in the seed. A **VIEWER now gets 403**
> on the access map (the pre-tightening that closed the long-standing read-authz gap —
> [[0046-roles-permissions-v2]] §4 / [[INVARIANTS]] INV-8). MEMBER/VIEWER permissions are otherwise
> ADMIN-configurable.
>
> The actor comes from the verified principal ([[0038-jit-user-provisioning]]); the `X-User-Id` shim is
> dev-only ([[0022-draft-visibility-auth-shim]]). A [[service-account]] actor lands in `grantedBySaId` /
> `revokedBySaId` instead (at-most-one-actor CHECK — [[0048-service-accounts]]).

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]). Note `userId` / `grantedById` / `revokedById` are
  **`uuid`** (`@db.Uuid`) because [[user]] uses `uuid`; `applicationId` is `cuid`.
- **Timestamps:** `createdAt`, `updatedAt`. **No `deletedAt`** — `revokedAt` expresses lifecycle,
  not soft delete ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `AccessGrant` → table `access_grants`. Validation schemas (`AccessGrantSchema`,
`CreateAccessGrantSchema`, `RevokeAccessGrantSchema`, `UpdateAccessGrantNotesSchema`,
`UpdateAccessGrantExpirySchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/access-grant.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `userId` | `uuid` | FK → [[user]] (grantee), required, `@db.Uuid`, `onDelete: Restrict`. |
| `applicationId` | `cuid` | FK → [[application]], required, `onDelete: Restrict`. |
| `accessLevel` | `string?` | free-form, app-defined (e.g. "admin"); lazyit never interprets it. |
| `grantedAt` | `datetime` | `@default(now())`; part of identity. Optional on create (backdate imports). |
| `revokedAt` | `datetime?` | `null` while active; set to end the grant. Not a soft delete. |
| `expiresAt` | `datetime?` | the expiry sweeper revokes the grant once it passes (see Business rules). `null` = no expiry. |
| `grantedById` | `uuid?` | FK → [[user]], `@db.Uuid`, `onDelete: SetNull`. The **human** grantor; null = system. |
| `revokedById` | `uuid?` | FK → [[user]], `@db.Uuid`, `onDelete: SetNull`. The **human** revoker; null = system. |
| `grantedBySaId` | `cuid?` | FK → [[service-account]], `onDelete: SetNull`. The **non-human** grantor. At-most-one-actor CHECK with `grantedById`. |
| `revokedBySaId` | `cuid?` | FK → [[service-account]], `onDelete: SetNull`. The **non-human** revoker. At-most-one-actor CHECK with `revokedById`. |
| `notes` | `string?` | optional free text; editable; `null` clears. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |

Indexes: `@@index([userId])`, `@@index([applicationId])`. **No uniqueness constraint** (multi-grant).

## Endpoints

`apps/api/src/access-grants/` (`AccessGrantsModule`). The authenticated principal is the actor on
create/revoke (see the note above). Documented via Swagger ([[0018-api-documentation-swagger]]).

- `POST /access-grants` — open a grant. `userId`/`applicationId` must be live and the person active
  → else `400` (FK errors also map to `400`). The principal is recorded in `grantedById` or `grantedBySaId`.
- `GET /access-grants?userId=&applicationId=&activeOnly=&includeExpired=&limit=&offset=&page=` —
  list, newest first, paginated ([[0030-list-pagination-contract]]). `activeOnly` **defaults to true**
  (`revokedAt = null`); `includeExpired` **defaults to true** (pass `false` to hide active grants
  already past `expiresAt` that the sweeper has not revoked yet).
- `GET /access-grants/mine?activeOnly=&includeExpired=&limit=&offset=&page=` — the caller's **own**
  grants, paginated ([[0030-list-pagination-contract]]). `activeOnly` **defaults to false** (revoked
  history included). A self-read: any authenticated human, no `accessGrant:read` needed; the user id
  comes only from the principal, never a parameter. Service accounts get `403`. Each grant carries the
  coarse `provisioning` status (#1700) — see [Provisioning status](#provisioning-status). Only this
  self-read returns it; the admin lists do not.
- `GET /access-grants/:id` — one by id (`404` if missing).
- `PATCH /access-grants/:id/revoke` — body `{ notes? }`; sets `revokedAt = now()` and the principal in
  `revokedById` or `revokedBySaId`. Already revoked, or revoked concurrently first → `409`.
- `POST /access-grants/batch/revoke` — body `{ ids, notes? }`; revokes each active grant in one
  transaction and returns the per-id outcome. Missing ids are skipped as `not_found`; already (or
  concurrently) revoked ones as `already_in_state` — never a rollback of the rest.
- `PATCH /access-grants/:id/notes` — body `{ notes }` (`null` clears). Metadata edit, no actor.
- `PATCH /access-grants/:id/expiry` — body `{ expiresAt }` (`null` = permanent). Metadata edit,
  no actor. The edit itself revokes nothing, but an `expiresAt` already in the past is revoked by the
  next expiry sweep, with the deprovision workflow; a revoked grant is never reactivated. An
  `expiresAt` earlier than the grant's `grantedAt` → `400`.
- **No `DELETE`** — by design (append-only).

Plus the natural sub-resource endpoints on the related entities:

- `GET /users/:id/access-grants?activeOnly=&includeExpired=` — grants of one [[user]] (`404` if the
  user is missing/soft-deleted).
- `GET /applications/:id/access-grants?activeOnly=&includeExpired=` — grants on one [[application]],
  unpaged. Kept for older web clients; the Access tab moves to the paged route below.
- `GET /applications/:id/access-grants/page?status=&accessLevel=&noAccessLevel=&q=&limit=&offset=&page=`
  — one page of an application's grants with the filters run server-side (#1660,
  [[0030-list-pagination-contract]] envelope `{ items, total, limit, offset }`, default 50, max 200):
  - `status` (default `active`): `active` = not revoked; `expiring` = not revoked and `expiresAt`
    within `GRANT_EXPIRING_WITHIN_DAYS` (30, the dashboard's default) **including** grants already past
    expiry that the sweep has not revoked yet; `revoked`; `all`. Unknown → `400`.
  - `accessLevel` — exact level (1-100 characters); `noAccessLevel=true` — only grants with no level.
    Both at once → `400`.
  - `q` — person search: each whitespace token must match the grantee's first name, last name or
    email, case-insensitive (not accent-folded). An offboarded grantee stays searchable. `q` needs
    **`user:read`** on top of `accessGrant:read` (`403` otherwise), because a search over names and
    emails would otherwise reveal directory data the caller cannot list. At most 200 characters.
  - The order follows the status and there is **no `sort`** param (`400`): `active`/`all` by person
    (first name, last name), active before revoked, then newest grant; `expiring` soonest expiry
    first; `revoked` newest revocation first. The `id` tie-break is always last.
- `GET /applications/:id/access-grants/summary` — the Access tab's headline numbers over **all** the
  application's grants (`ApplicationGrantSummarySchema`): `counts` (`active`, `expiring`, `expired`,
  `revoked`, `all`), `levels` (`[{ accessLevel, count }]`, alphabetical, no level last),
  `offboardedHolders` (distinct offboarded people still holding an active grant — `null` without
  `user:read`) and `expiringWithinDays`.

**Export** — the access-review artefact ([[0103-data-export-streaming-path]]).
`GET /access-grants/export?userId=&applicationId=&activeOnly=&includeExpired=` and
`GET /applications/:id/access-grants/export?activeOnly=&includeExpired=` stream as CSV every grant the
matching list returns: same `accessGrant:read` (a VIEWER gets 403 by default), same filters and
defaults, and the per-application route `404`s on a missing or archived application like its list.
The per-application export also takes the paged route's `status`, `accessLevel`, `noAccessLevel` and
`q` (#1660), with the same rules (including `user:read` for `q`), so the file holds exactly the rows
the filtered Access tab shows. Mixing `status` with `activeOnly`/`includeExpired` is a `400`.
Columns: application, user, user email, access level, status (`active`, `expired` = past `expiresAt`
and not yet swept, `revoked`), granted at, granted by, expires at, revoked at, revoked by, notes,
grant ID. A service-account actor reads `<name> (service account)`. The names are joined, so each one
follows the read the screen would need to resolve it: user names and the email column need
`user:read`, the application name `application:read`, a service-account name `settings:manage`.
Without it the cell holds the id the list already returns, and the email column is left out. Every
export writes a [[data-export-log]] row.

## Provisioning status

The coarse, requester-facing answer to "was my account in the application set up?" (#1700, CEO
decision Q2 on #1344). Run history stays behind `workflow:read` ([[workflow-engine/security]] §4), so a
grantee cannot read it; instead the self-scope reads carry one of four values
(`GrantProvisioningSchema` in `@lazyit/shared`):

| The grant's latest `ACCESS_GRANTED` [[workflow-run]] | `provisioning` | Shown as |
| --- | --- | --- |
| none | `NONE` | No automation |
| `PENDING`, `RUNNING` | `IN_PROGRESS` | Setup in progress |
| `SUCCEEDED` | `DONE` | Set up |
| `AWAITING_INPUT` (a manual step), `FAILED`, `COMPENSATED` | `WAITING_ON_IT` | Waiting on IT |

- **Derived on read, no column, no migration.** The source is the latest run linked by `accessGrantId`
  with trigger `ACCESS_GRANTED`: highest `replaySeq` first (a replay-latest clones to seq + 1,
  [[0057-retry-fix-and-replay]]), then the newest. A retry resumes the same run, so its status moves
  with it. A deprovision (`ACCESS_REVOKED`) run is not provisioning and never changes the value.
- **`NONE`** also covers a grant opened before the application had an enabled workflow, a grant whose
  trigger lookup failed (the grant path swallows it, [[0054-applications-workflow-engine]]), and a
  cloned grant the clone did not run the engine for ([[0058-user-manager-and-clone-actions]]).
- **`COMPENSATED`** reads as waiting on IT: it is a failure whose external effects were rolled back, so
  the account does not exist. `AWAITING_INPUT` is only a manual step today (no inbound-callback step
  ships yet).
- **One batched query per page** (`AccessGrantsService.provisioningFor`, on the
  `workflow_runs(accessGrantId)` index): it selects only the grant id and the run status — no workflow
  name, step, error or payload is read, so none can leak.
- **Where it appears:** `GET /access-grants/mine` (every grant) and `GET /access-requests/mine` (the grant
  an approved request created; `null` otherwise — [[access-request]]). The field is optional in the
  contract, so a client that predates it ignores it, and an older API simply omits it. The web shows it
  on the active grants and approved requests of `/profile`; revoked history shows none.
- The mapping lives in `apps/api/src/access-grants/grant-provisioning.ts`; a run state added later
  reads `WAITING_ON_IT` until it is mapped there.

## Not yet implemented (deferred)

- A soft-delete-time guard on apps/users with active grants. (Auto-revoke on `expiresAt` is now
  implemented — see `expiresAt` above.)

Related: [[user]] · [[application]] · [[application-category]] · [[access-request]] · [[workflow-run]] ·
[[asset-assignment]] · [[service-account]] · [[shared-package]] · [[0023-access-management-design]] ·
[[0019-asset-assignment-integrity]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[0016-auth-strategy-deferred]] · [[0022-draft-visibility-auth-shim]] ·
[[0040-rbac-roles]] · [[0046-roles-permissions-v2]] · [[0048-service-accounts]] ·
[[0018-api-documentation-swagger]] · [[INVARIANTS]]
