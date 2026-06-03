---
title: RolePermission
tags: [domain, entity, auth, authz, permissions]
status: accepted
created: 2026-06-03
updated: 2026-06-03
---

# RolePermission

> 🟢 implemented · Area: Auth / AuthZ · see [[0046-roles-permissions-v2]]

## Purpose

The **editable role → permission map** introduced by Roles & Permissions v2
([[0046-roles-permissions-v2]]). Authorization shifted from "is the caller's role in this set?"
(the retired `@Roles()` gate) to "does the caller's role *hold* this permission?". `RolePermission`
is the **DB-first authorization source** ([[INVARIANTS]] INV-8) that answers that question: each row
binds a [[user]] `Role` to one permission literal from the frozen catalog.

The three roles themselves stay **fixed** — `enum Role { ADMIN MEMBER VIEWER }` is unchanged. What
became configurable is the *permissions* each role grants. This is **not** dynamic custom roles
(deferred to a future ADR).

## Relationships

- **maps** a [[user]] `Role` (`ADMIN` / `MEMBER` / `VIEWER`) to **one** catalog permission.
- The catalog of permission literals (`domain:action`) lives **as code** in `@lazyit/shared`
  (`PermissionSchema`, [[shared-package]]) — `RolePermission.permission` is a plain `String` that
  must be a member of that catalog. The DB stays a flat key/value the seed and the config endpoint
  write 1:1; a catalog-foreign row is ignored at resolve time (a typo can't mint a power).

## Business rules

- **DB-first, never a token claim.** Every privilege decision resolves a role's permission set from
  these rows (via `PermissionResolverService`), exactly like roles do — INV-1 / INV-8
  ([[INVARIANTS]]). A forged/misconfigured token can never confer a permission.
- **The ADMIN set is immutable and full.** ADMIN is, by decision, the **complete** catalog and is
  never editable — the resolver short-circuits ADMIN to the whole catalog **without** a DB read, so a
  bad seed can never lock ADMIN out. The config endpoint refuses to write ADMIN rows. This keeps the
  last-admin / first-admin invariants intact (INV-7 + the ADR-0040 last-admin guard).
- **MEMBER + VIEWER are fully configurable** within the catalog. The matrix UI / `PUT /config/permissions`
  may grant MEMBER or VIEWER a `:delete` or a coarse verb (`settings:manage` / `user:manage` /
  `accessGrant:grant`); the only guardrails are *ADMIN-immutable* + *catalog-membership*. The UI marks
  these ⚠ "Admin-level" and confirms, but the server does not block — an admin-initiated delegation is
  accepted by design.
- **Seeded behavior-preserving, with two pre-tightened reads.** The seed is derived 1:1 from a single
  source-of-truth constant `DEFAULT_ROLE_PERMISSIONS` ([[shared-package]]) so the documented matrix and
  the seeded rows can never drift (a wrong seed fails the golden test). The seeded matrix:

  | Role | Seeded permissions |
  | --- | --- |
  | **ADMIN** | the COMPLETE catalog (immutable/full) |
  | **MEMBER** | every `:read` + every `:write` (no `:delete`, no coarse verb) |
  | **VIEWER** | every `:read` **except** `accessGrant:read` and `user:read` |

  So every `<domain>:read` is open to all three roles **except** the two pre-tightened reads
  (`accessGrant:read`, `user:read`), which are ADMIN + MEMBER only — VIEWER can no longer enumerate the
  access map or the user directory. This closed the long-standing read-authz gap (the old DEF-001
  residual). See [[user]] and [[0046-roles-permissions-v2]] §4.
- **Permissions are lazyit-local.** They are NEVER mirrored to the IdP (BYOI-safe); only the three
  coarse roles keep their `grantRole` write-back ([[0043-zitadel-source-of-truth]] §3).

## Conventions

- **ID:** none — the composite primary key `(role, permission)` is the row's identity. It is small
  *configuration*, not domain data.
- **Timestamps / soft delete:** **none** — no `createdAt`/`updatedAt`/`deletedAt`. The matrix is
  replaced wholesale (per editable role) by the config endpoint; the audit trail of *who changed what*
  lives in the append-only [[permission-audit-log]], not on the row ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `RolePermission` → table `role_permissions`. The permission catalog + `RolePermissionMatrix`
wire shape + `DEFAULT_ROLE_PERMISSIONS` live in `@lazyit/shared`
(`packages/shared/src/schemas/permission.ts`) and are the source of truth ([[shared-package]]).

| Field | Type | Notes |
| --- | --- | --- |
| `role` | `Role` | `ADMIN` / `MEMBER` / `VIEWER` ([[0040-rbac-roles]]); part of the composite PK. |
| `permission` | `string` | A catalog literal (`domain:action`); plain `String`, validated against `PermissionSchema` in `@lazyit/shared`, not a Postgres enum (so adding a permission never needs a migration). Part of the composite PK. |

> [!note] Why `permission` is a plain `String`, not a DB enum
> The closed catalog lives as zod in `@lazyit/shared`; the DB stays a flat key/value the seed and the
> config endpoint write 1:1. A catalog-foreign row is *ignored* by the resolver, so a stray/typo row
> can never confer a power — and the catalog can grow without an enum migration.

## Endpoints

`apps/api/src/config/` (`ConfigModule`), both `@RequirePermission('settings:manage')` (ADMIN-only in
the seed):

- `GET /config/permissions` — returns the current `RolePermissionMatrix` (ADMIN reported as the COMPLETE
  catalog — what the resolver enforces, never the rows).
- `PUT /config/permissions` — replaces the **MEMBER + VIEWER** sets wholesale (a full PUT), validated
  against the frozen catalog (unknown permission → 400). The strict body (`UpdateRolePermissionsSchema`)
  accepts ONLY `MEMBER`/`VIEWER` keys, so an `ADMIN`/extra key → 400 (ADMIN immutable). Transactional +
  audited ([[permission-audit-log]], one row per grant/revoke) + cache-coherent (the resolver cache is
  invalidated on commit).
- `GET /config/my-permissions` — any authenticated user; returns the CALLER's effective set
  `{ role, permissions: Permission[] }` via the same resolver, so the web can derive `can('domain:action')`
  without polluting the `User` wire shape.

**Web:** the role-first editor at `settings/roles/permissions` (presets + plain-language capability
toggles + a fine-tune disclosure; NOT a comparison grid) edits one editable role at a time, ADMIN shown
locked. The `can()` infra (`useMyPermissions`/`useCan` over `/config/my-permissions`, fails closed) gates
all write/delete affordances ([[0046-roles-permissions-v2]] P6b/P7).

Related: [[user]] · [[permission-audit-log]] · [[service-account-permission]] · [[shared-package]] ·
[[0046-roles-permissions-v2]] · [[0040-rbac-roles]] · [[0043-zitadel-source-of-truth]] ·
[[0006-soft-delete-and-auditing]] · [[INVARIANTS]]
