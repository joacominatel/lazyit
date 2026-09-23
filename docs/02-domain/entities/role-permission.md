---
title: RolePermission
tags: [domain, entity, auth, authz, permissions]
status: accepted
created: 2026-06-03
updated: 2026-09-23
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
  | **MEMBER** | every `:read` (minus the admin-only reads) + every `:write` + `accessRequest:create` + the AI channel verbs `ai:use` / `ai:connect` (no `:delete`, no coarse verb) |
  | **VIEWER** | every `:read` **except** `accessGrant:read`, `user:read` **and** the admin-only reads, + `accessRequest:create` |

  `ai:use` and `ai:connect` ([[0097-ai-assistant-mcp-and-headless-api]] decision 1) are the
  `MEMBER_DEFAULT_CAPABILITIES`: channel verbs, not capabilities — the AI acts with the principal's own
  permissions — so they are seeded to ADMIN + MEMBER, carry the within-default `edit` tier, and expose
  nothing until an admin enables AI or MCP for the instance. They reach existing instances through the
  seed-once ledger below, not a data migration.

  So every `<domain>:read` is open to all three roles **except** two tighter tiers: the two
  **pre-tightened reads** (`accessGrant:read`, `user:read`) are ADMIN + MEMBER only — VIEWER can no
  longer enumerate the access map or the user directory; and the **admin-only reads**
  (`ADMIN_ONLY_READS`, today just `logs:read`) are seeded to **ADMIN only** — strictly more restrictive
  than the pre-tightening, excluded from BOTH MEMBER and VIEWER. The two sets are disjoint (a read is
  either pre-tightened or admin-only, never both). `logs:read` is the **first admin-only read** (issue
  #175): it gates the future Reports/Informes section over the estate-wide activity history, which
  aggregates who-did-what across every domain and is therefore the most sensitive read in the catalog.
  Like every non-ADMIN row it stays **configurable** — an admin may grant it to MEMBER/VIEWER from the
  role matrix (`PUT /config/permissions`) — but it is never *seeded* to them. This closed the
  long-standing read-authz gap (the old DEF-001 residual). See [[user]] and
  [[0046-roles-permissions-v2]] §4.
- **Default grants are applied once per instance; revocations are durable** (issue #1314). The seed
  runs on every deploy, but it grants a default pair only when the seed-once ledger
  (`AppliedRolePermissionDefault`, below) has never recorded it, and it records the pair in the same
  transaction. A revoke through `PUT /config/permissions` deletes the `RolePermission` row and leaves
  the ledger alone, so the next deploy does not bring it back. A permission newly added to the catalog
  has no ledger row, so every instance receives its defaults exactly once, on the first deploy that
  ships it — no per-permission data migration. The seed never deletes a grant: admin-added rows and
  rows for permissions that left the defaults stay as they are.
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

## Seed-once ledger — `AppliedRolePermissionDefault`

Prisma model `AppliedRolePermissionDefault` → table `applied_role_permission_defaults`. One row per
(role, permission) pair whose default grant is **settled**: the seed applied it, or the pair already
existed or had been revoked when the ledger was introduced. The seed consults it; nothing else reads
or writes it — the config endpoint never touches it.

| Field | Type | Notes |
| --- | --- | --- |
| `role` | `Role` | Part of the composite PK. |
| `permission` | `string` | A permission literal; part of the composite PK. |
| `createdAt` | `DateTime` | When the pair was settled. |

Append-only ([[0006-soft-delete-and-auditing]]): `createdAt` only, never updated or deleted. Deleting
a row would make the next deploy re-grant that default.

**Upgrade backfill.** The `add_applied_role_permission_defaults` migration filled the ledger with every
pair in `role_permissions` plus every pair [[permission-audit-log]] records as `REVOKE`d. Existing
instances therefore kept every grant they had, and revocations still in effect stayed revoked. A default
pair in neither set had never been applied on that instance, so the next seed applied it once — what the
old upsert would have done on that deploy anyway. What the backfill cannot recover: a revocation that an
older seed had already silently undone looks like any other held grant, because the old seed wrote no
audit row. Operators should review the permission matrix once after the update that ships this ledger.

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
