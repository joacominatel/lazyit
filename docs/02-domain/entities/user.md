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

## Business rules

- Atomic entity — implemented first, alongside [[location]].
- Offboarding a user must not erase history: assignments and grants are *released*, not
  deleted (soft delete + lifecycle timestamps).
- **Identity / auth:** the local User is the source of truth for the domain. Authentication is
  handled by an external IdP (OIDC) whose `sub` maps to `externalId`; the global guard JIT-provisions
  a User on first login ([[0038-jit-user-provisioning]]) — we do **not** implement our own auth.
  `AUTH_MODE=shim` keeps the `X-User-Id` header path for dev/test.
- **Authorization (RBAC):** a single `role` ([[0040-rbac-roles]]) governs what a user may do —
  `ADMIN` (full access, including Access-grant writes, Users administration and destructive deletes),
  `MEMBER` (normal inventory / KB / asset operations) and `VIEWER` (read-only everywhere). Enforced by
  the `RolesGuard`, which composes after the auth guard. The **first** user ever provisioned (seed or
  first JIT login) is `ADMIN`; everyone else defaults to `MEMBER`. Only an `ADMIN` can change a role
  (the Users controller is ADMIN-gated), so there is no self-escalation path.

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
| `role` | `Role` | `@default(MEMBER)`. RBAC role: `ADMIN` / `MEMBER` / `VIEWER` ([[0040-rbac-roles]]). First user ever provisioned = `ADMIN`. |
| `externalId` | `string?` | `@unique`, nullable. Holds the IdP `sub`; populated on first OIDC login ([[0038-jit-user-provisioning]]); `null` for unlinked users ([[0016-auth-strategy-deferred]]). |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | Soft delete — `null` while live; reads filter `deletedAt: null` ([[0006-soft-delete-and-auditing]]). |

> [!note] `isActive` vs `deletedAt` — independent concepts
> `isActive = false` means the person is **offboarded/disabled but retained** (tickets and past
> assignments still reference them) — this is the offboarding rule above. `deletedAt` means the
> record is **soft-deleted** (hidden from normal queries). A user can be inactive yet not
> deleted. Creation always starts active; deactivation is a `PATCH`.

## Endpoints

`apps/api/src/users/` (`UsersModule`): `GET /users` (excludes soft-deleted), `GET /users/me`
(the current authenticated caller, **including their role** — declared before `:id` so the literal
`me` isn't parsed as a uuid; the OIDC token doesn't carry the lazyit role, so the web reads it here),
`GET /users/:id`, `POST /users`, `PATCH /users/:id`, `DELETE /users/:id` (soft delete),
`POST /users/:id/offboard`, `POST /users/:id/restore` (re-onboard: clears `deletedAt`; does NOT
re-grant access or re-assign assets — [[0041-soft-delete-reuse-and-restore]]).
All **write** endpoints (create / update / delete / offboard / restore) are **ADMIN-only**
(`@Roles('ADMIN')`, [[0040-rbac-roles]]); the reads (incl. `me`) are open to any authenticated user. Bodies validated against the
shared schemas and documented via Swagger ([[0018-api-documentation-swagger]]). Also
`GET /users/:id/assignments?activeOnly=` lists the assets assigned to the user ([[asset-assignment]])
and `GET /users/:id/access-grants?activeOnly=&includeExpired=` lists their application access
([[access-grant]]).

> [!note] RBAC safety guards (ADR-0040, Round 3)
> Changing a `role` is governed by two service-level guards. The API **refuses to remove the last
> remaining `ADMIN`** — demoting away from `ADMIN`, offboarding or deleting the final administrator
> returns **409 Conflict** — and **no user can change their own role** (**403 Forbidden**). Role
> management is otherwise done by an `ADMIN` from the **Users** section (a per-user role Select);
> the very first `ADMIN` on a pre-existing DB is set out-of-band via `bun run set-role` ([[auth-bootstrap]]).

**Web:** `users/[id]` is the asset-centric **per-person** detail page (the counterpart to the asset
detail) — it composes the two nested reads above plus the user's authored [[article]]s, answering
"who can access what" for one person and cross-linking user ⇄ asset / application. See
[[0020-frontend-data-layer]].

Related: [[asset-assignment]] · [[access-grant]] · [[access-request]] · [[ticket]] ·
[[asset-centric]] · [[shared-package]] · [[0013-zod-validation-pipe]] ·
[[0016-auth-strategy-deferred]] · [[0038-jit-user-provisioning]] · [[0040-rbac-roles]]
