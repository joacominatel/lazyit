---
title: User
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-06-01
---

# User

> 🟢 implemented · Area: People · Implementation order: 1 (atomic, no dependencies)

## Purpose

A person in the organization. **Central to access, peripheral to assets** ([[asset-centric]]):
users come and go while assets persist, so the model attaches users *to* assets rather than
the reverse.

## Relationships

- **owns** N [[asset]]s via [[asset-assignment]] (with history).
- **holds** N [[access-grant]]s to [[application]]s.
- **raises** N [[access-request]]s.
- **is referenced by** N [[ticket]]s (requester, affected user, or assignee).
- **has** an append-only [[user-history]] — its own lifecycle log (create / update / role change /
  manager change / offboard / restore / password-reset), the User counterpart of [[asset-history]]
  (DEBT-2, #185 — [[0050-user-history-and-activity-user-entity]]). A User is also the **actor** on
  history rows it caused (`performedById`).
- **reports to** at most one **manager** — either another lazyit User (self-FK `managerId`) or a
  free-text `managerName` fallback, and **has** N direct `reports` (the inverse self-relation). No
  cycles, no self-manage ([[0058-user-manager-and-clone-actions]]).

## Business rules

- Atomic entity — implemented first, alongside [[location]].
- Offboarding a user must not erase history: assignments and grants are *released*, not
  deleted (soft delete + lifecycle timestamps).
- **Auditable lifecycle (DEBT-2, #185):** every User write emits an append-only [[user-history]] row
  **transactionally** with the change — `CREATED` on provisioning, `UPDATED` on a profile edit,
  `ROLE_CHANGED` (payload `{ from, to }`) on a role change, `MANAGER_CHANGED` (payload `{ from, to }`,
  each side a user-id / external-name / null — [[0058-user-manager-and-clone-actions]]) on a manager
  change, `DELETED` on offboard, `RESTORED` on re-onboard, `PASSWORD_RESET_SENT` when a reset link is
  requested. This supersedes the fire-and-forget IdP write-back log lines for *durability*: those
  structured logs remain, but the queryable trail now lives in the DB and surfaces in the
  [[recent-activity]] feed (`entityType = 'user'`).
- **Identity / auth:** the local User is the source of truth for the domain. Authentication is
  handled by an external IdP (OIDC) whose `sub` maps to `externalId`; the global guard JIT-provisions
  a User on first login ([[0038-jit-user-provisioning]]) — we do **not** implement our own auth.
  `AUTH_MODE=shim` keeps the `X-User-Id` header path for dev/test.
- **Authorization (Roles & Permissions v2):** the three roles stay **fixed** —
  `enum Role { ADMIN MEMBER VIEWER }` is unchanged ([[0040-rbac-roles]]) — but what each role *grants*
  is now a configurable set of **fine-grained permissions** ([[0046-roles-permissions-v2]]). A privilege
  decision asks **"does the caller's role hold permission `domain:action`?"**, resolved **DB-first** from
  the [[role-permission]] rows ([[INVARIANTS]] INV-8) — never from a token claim. Enforcement is a
  **single primitive**, `@RequirePermission(...)` + the permission guard (composing after the auth
  guard); the legacy coarse `@Roles()` gate from ADR-0040 is **retired**.
  - **ADMIN** holds the COMPLETE catalog and is **immutable/full** (never editable), so an ADMIN is
    always omnipotent and the last-admin / first-admin invariants stay intact.
  - **MEMBER** holds every `:read` + `:write` (ordinary inventory / KB / asset operations); **VIEWER** is
    read-only **except** it can no longer read the access map (`accessGrant:read`) or the user directory
    (`user:read`) — those two reads are pre-tightened to ADMIN + MEMBER (the read-authz gap closed).
  - **MEMBER / VIEWER are fully configurable** by an ADMIN within the catalog (an admin may delegate a
    `:delete` or a coarse verb; the UI warns ⚠ but the server accepts it). Permissions are
    **lazyit-local** — never mirrored to the IdP ([[0043-zitadel-source-of-truth]] §3). See
    [[role-permission]].
  - The **first** user ever provisioned (seed or first JIT login) is `ADMIN`; everyone else defaults to
    `VIEWER` (least-privilege; flipped from `MEMBER` by [[0043-zitadel-source-of-truth]] Phase 1). Only an
    ADMIN can change a role (Users administration is gated `user:manage`, ADMIN-only in the seed), and no
    user can change their own role — so there is no self-escalation path.

## Conventions

- **ID:** `uuid()` — sensitive / externally-exposed entity ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields

Implemented in `apps/api/prisma/schema.prisma` (`User` → table `users`). Validation schemas
(`UserSchema`, `CreateUserSchema`, `UpdateUserSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/user.ts`) and are the source of truth for both api and web
([[shared-package]], [[0013-zod-validation-pipe]]).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | `@default(uuid())`, `@db.Uuid` — sensitive/exposed ([[0005-id-strategy]]). |
| `email` | `string` | Required, **case-insensitive** (`@db.Citext`, [[0041-soft-delete-reuse-and-restore]]). Unique among **live** rows only — a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL in the migration; no `@unique`), so a soft-deleted email is freed for reuse / restore. Write payloads normalize it (trim + lowercase). |
| `firstName` | `string` | required. |
| `lastName` | `string` | required. |
| `isActive` | `boolean` | `@default(true)`. Activation flag — see note below. |
| `role` | `Role` | `@default(VIEWER)` (flipped from `MEMBER` by [[0043-zitadel-source-of-truth]]). The fixed role `ADMIN` / `MEMBER` / `VIEWER` ([[0040-rbac-roles]]); what each role *grants* is the configurable [[role-permission]] matrix ([[0046-roles-permissions-v2]]). First user ever provisioned = `ADMIN`; all others default to `VIEWER`. |
| `externalId` | `string?` | `@unique`, nullable. Holds the IdP `sub`; populated on first OIDC login ([[0038-jit-user-provisioning]]); `null` for unlinked users ([[0016-auth-strategy-deferred]]). |
| `legajo` | `string?` | Employee/file number (LATAM payroll/HR), [[0058-user-manager-and-clone-actions]]. Optional, stored verbatim (trimmed on write). Unique among **live** rows only — a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL; no `@unique`), so offboarding frees it for reuse/restore (the `email` precedent, [[0041-soft-delete-reuse-and-restore]]). |
| `username` | `string?` | Directory/display handle distinct from `email`/`externalId`, [[0058-user-manager-and-clone-actions]]. Optional, normalized (trim + lowercase) so `Ana`/`ana` collide. Same live-only partial unique index. **NOT an auth credential** and **never** an account-linking key (that stays `email`/`externalId`, INV-2). |
| `managerId` | `uuid?` | The manager when they ARE a lazyit user — self-FK → `User`, `onDelete: SetNull` ([[0058-user-manager-and-clone-actions]]). Mutually exclusive with `managerName` (DB CHECK `users_manager_at_most_one`; both-null = no manager). A DB CHECK `users_manager_not_self` forbids self-manage; the service also rejects a **cycle** (DFS up the chain). A soft-deleted linked manager is surfaced as `isOffboarded` on read, never a dangle. |
| `managerName` | `string?` | Free-text fallback when the manager is **not** a lazyit user, [[0058-user-manager-and-clone-actions]]. Normalized (trim). Mutually exclusive with `managerId`. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | Soft delete — `null` while live; reads filter `deletedAt: null` ([[0006-soft-delete-and-auditing]]). |

> [!note] Manager identity graph + clone-with-chosen-actions ([[0058-user-manager-and-clone-actions]])
> The read `UserSchema` resolves the manager FK to a **redaction-safe descriptor** —
> `{ type:"user"; id; firstName; lastName; isOffboarded } | { type:"external"; name } | null` — never
> the raw `managerId`/`managerName` columns (so a deleted manager surfaces `isOffboarded:true`, never a
> leak/dangle). Create/Update accept a `manager` **input union** (`{ managerId }` xor `{ managerName }`
> xor `null`) mirroring the DB CHECK, plus optional normalized `legajo`/`username`. A manager change
> emits a **`MANAGER_CHANGED`** [[user-history]] row (payload `{ from, to }`, each side a user-id /
> external-name / null). **`POST /users/:id/clone`** mints a NEW user (a normal create — never copies the
> source's email/legajo/username or `externalId`) and mirrors the source's **selected** active
> [[asset-assignment]]s + [[access-grant]]s as **new** append-only rows for the new user (actor = the
> cloning admin). The **engine toggle** `fireWorkflowsOnClonedGrants` (default **false**, safe-by-default)
> decides whether each cloned grant fires the [[0054-applications-workflow-engine|workflow engine]]
> (`ACCESS_GRANTED`, after commit) or is recorded bookkeeping-only; the choice is audited in the clone's
> CREATED history. Response is the per-item batch shape `{ created, skipped: [{ id, reason }] }`. **Out of
> scope (separate follow-up):** the mapper `grantee.manager`/`legajo`/`username` token group.

> [!note] `isActive` vs `deletedAt` — independent concepts
> `isActive = false` means the person is **offboarded/disabled but retained** (tickets and past
> assignments still reference them) — this is the offboarding rule above. `deletedAt` means the
> record is **soft-deleted** (hidden from normal queries). A user can be inactive yet not
> deleted. Creation always starts active; deactivation is a `PATCH`.

## Endpoints

`apps/api/src/users/` (`UsersModule`): `GET /users` (excludes soft-deleted), `GET /users/me`
(the current authenticated caller, **including their role** — declared before `:id` so the literal
`me` isn't parsed as a uuid; the OIDC token doesn't carry the lazyit role, so the web reads it here),
`GET /users/:id`, `POST /users`, `POST /users/:id/clone` (clone-with-chosen-actions —
[[0058-user-manager-and-clone-actions]]; see the manager/clone note above), `PATCH /users/:id`,
`DELETE /users/:id` (soft delete), `POST /users/:id/offboard`, `POST /users/:id/restore` (re-onboard:
clears `deletedAt`; does NOT re-grant access or re-assign assets — [[0041-soft-delete-reuse-and-restore]]),
and `POST /users/:id/reset-password` (admin-triggered password reset — see the IdP write-back note below).
All **write** endpoints (create / update incl. name/email/role / delete / offboard / restore /
reset-password) are gated `@RequirePermission('user:manage')` — ADMIN-only in the seed, **not**
`user:write` (which MEMBER holds) ([[0046-roles-permissions-v2]] P4). The directory **reads** `GET /users` and `GET /users/:id` (and the
nested reads below) are gated `@RequirePermission('user:read')` — ADMIN + MEMBER (a VIEWER gets 403;
this is the pre-tightening). `GET /users/me` stays OPEN (the self-read the web gates its UI off; the
OIDC token doesn't carry the lazyit role). Bodies validated against the
shared schemas and documented via Swagger ([[0018-api-documentation-swagger]]). Also
`GET /users/:id/assignments?activeOnly=` lists the assets assigned to the user ([[asset-assignment]])
and `GET /users/:id/access-grants?activeOnly=&includeExpired=` lists their application access
([[access-grant]]).

> [!note] `GET /users` list item — derived activity counts (issue #386)
> The `GET /users` LIST item is the full `UserSchema` (so it already carries the resolved `manager`
> descriptor + `legajo`/`username`, [[0058-user-manager-and-clone-actions]]) **plus two OPTIONAL,
> list-only activity counts** (`UserListItemSchema` in `@lazyit/shared`, `schemas/user-list.ts`):
> `assetsInPossession` (active [[asset-assignment]]s, `releasedAt IS NULL` — [[0019-asset-assignment-integrity]])
> and `appAccesses` (active [[access-grant]]s, `revokedAt IS NULL` — [[0023-access-management-design]]).
> They power the [[0030-list-pagination-contract|Users column picker]] (#386). Both are **batched per
> page** — `findPage` issues exactly **one Prisma `groupBy` per count** over the page's user ids (two
> queries total, never N+1) and attaches the result to each row (`0` when none). They are **optional +
> additive**: the single-user reads (`GET /users/:id`, `/me`, create/update) return the bare
> `UserSchema` and DON'T carry them, so existing consumers are unaffected. The page envelope itself is
> unchanged (ADR-0030 `Page<T>` — the counts ride on each row).

> [!note] RBAC safety guards (ADR-0040, Round 3)
> Changing a `role` is governed by two service-level guards. The API **refuses to remove the last
> remaining `ADMIN`** — demoting away from `ADMIN`, offboarding or deleting the final administrator
> returns **409 Conflict** — and **no user can change their own role** (**403 Forbidden**). Role
> management is otherwise done by an `ADMIN` from the **Users** section (a per-user role Select);
> the very first `ADMIN` on a pre-existing DB is set out-of-band via `bun run set-role` ([[auth-bootstrap]]).

> [!note] Admin profile edits + password reset write back to the IdP (issue #149)
> `PATCH /users/:id` lets an `ADMIN` edit `firstName` / `lastName` / `email` (alongside `role`). A
> name/email change is **mirrored back to Zitadel** (the v2 user service: profile `PUT` + a
> pre-verified email `POST`) inside the same **no-split-brain** pattern as a role change — if the
> Management call fails, the local row is reverted and the request is **503** ([[INVARIANTS]] INV-5).
> The `email` is the **account-linking key** ([[INVARIANTS]] INV-2, `citext`): the write-back updates
> the **existing** Zitadel user (same `sub`/`externalId` — never a re-link, SEC-006) and sets the new
> address **pre-verified**, so the change does **not** force re-verification or break login. `externalId`
> can never be set via the API.
> `POST /users/:id/reset-password` triggers **Zitadel's own** password-reset flow (Management API,
> `password_reset` with `sendLink`): lazyit **never** stores/sets/sends a password ([[0016-auth-strategy-deferred]],
> [[0037-idp-choice-zitadel-byoi]]) — **Zitadel emails the link via ZITADEL's SMTP**, which the operator
> must have configured for delivery. It is refused for an **inactive** user (**422**) and surfaces an
> honest **501** ("managed by your identity provider") under BYOI / generic OIDC or for a user with no
> IdP link ([[INVARIANTS]] INV-4) — never a misleading success. Both rely on the same Private-Key-JWT
> Management auth as the create/role write-backs ([[0043-zitadel-source-of-truth]] §3).

**Web:** `users/[id]` is the asset-centric **per-person** detail page (the counterpart to the asset
detail) — it composes the two nested reads above plus the user's authored [[article]]s, answering
"who can access what" for one person and cross-linking user ⇄ asset / application. See
[[0020-frontend-data-layer]].

Related: [[asset-assignment]] · [[access-grant]] · [[access-request]] · [[ticket]] ·
[[role-permission]] · [[service-account]] · [[asset-centric]] · [[shared-package]] ·
[[0013-zod-validation-pipe]] · [[0016-auth-strategy-deferred]] · [[0038-jit-user-provisioning]] ·
[[0040-rbac-roles]] · [[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[INVARIANTS]]
