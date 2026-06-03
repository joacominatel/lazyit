---
title: ServiceAccount
tags: [domain, entity, auth, authn, authz, service-accounts]
status: accepted
created: 2026-06-03
updated: 2026-06-03
---

# ServiceAccount

> 🟢 implemented · Area: Auth / AuthZ · see [[0048-service-accounts]]

## Purpose

A **first-class non-human principal** — a credential for automation (a CI runner that registers a
freshly-imaged asset, a nightly stock-reconcile script, an integration that opens access grants).
Introduced by [[0048-service-accounts]] so bots no longer need a human [[user]] row + shared OIDC
token.

A service account is a **SEPARATE entity, not a flag on [[user]]** (CEO decision): it cannot enter JIT
provisioning, the user directory, email-linking, or the last-admin / first-admin math
([[INVARIANTS]] INV-7, INV-SA-3) because it is a different model. It authenticates with a
**lazyit-native token** (no IdP — BYOI-safe) and is authorized by **direct permission grants** from the
SAME frozen catalog humans use ([[service-account-permission]]) — never a `Role`, never ADMIN.

## Relationships

- **created by** an optional [[user]] (`createdById` → `users`, `onDelete: SetNull`).
- **holds** N [[service-account-permission]]s — its entire authorization (direct grants from the
  `@lazyit/shared` catalog; never a `Role`/`RolePermission`).
- **acts on** the audit-bearing append-only tables via a nullable `serviceAccountId` actor column
  ([[asset-history]], [[asset-assignment]], [[access-grant]], [[consumable-movement]],
  [[article-version]], [[article-link]]) — honest attribution, never a fake `userId`
  ([[INVARIANTS]] INV-SA-4).
- **logs** its own lifecycle to the append-only [[service-account-audit-log]]
  (mint/rotate/revoke/restore/permission-change).

## Business rules

- **Token: a lazyit-native bearer `lzit_sa_<id>_<secret>`.** The secret is `crypto.randomBytes(32)`
  base64url (256 bits), stored only as a **SHA-256 hash** (`tokenHash`) + a short non-secret
  `tokenPrefix` for display. The cleartext is shown **once** on create/rotate and is never recoverable
  or logged — losing it means **rotating**, not recovering. Verification is **DB-first** (the `id`
  segment looks the row up), **constant-time** (`timingSafeEqual`), and a missing / revoked / inactive /
  expired account is rejected as a **generic 401** (no enumeration oracle). A high-entropy random secret
  needs only a fast hash + constant-time compare, not bcrypt/argon2 ([[INVARIANTS]] INV-SA-1).
- **Authorized by direct grants; FAIL-CLOSED.** A service account passes ONLY `@Public` routes and
  routes whose `@RequirePermission(...)` it **fully holds** ([[service-account-permission]]). It does
  **not** inherit the human *open-by-default* for unannotated routes (INV-8): a bot hitting an
  unannotated, non-`@Public` route gets **403**. This is the single most important authZ difference from
  a human ([[INVARIANTS]] INV-SA-2).
- **Never a Role; never ADMIN-equivalent.** No `role` column, no role resolution, no wildcard — the
  permission set is exactly its grants ([[INVARIANTS]] INV-SA-3).
- **Optional expiry + one-click rotate.** `expiresAt` is optional (no forced expiry in v1); `isActive`
  toggles it off without deleting; `POST /:id/rotate` mints a new secret (shown once) and invalidates
  the old.
- **Audited.** Every management action appends a [[service-account-audit-log]] row; every *domain* action
  it performs is attributed to its `serviceAccountId` actor column, never a fabricated human
  ([[INVARIANTS]] INV-SA-4).
- **Humans stay UNCHANGED.** The [[user]] table, JIT, role resolution and the last-admin guard are not
  touched or weakened.

## Conventions

- **ID:** `cuid()` — a domain entity, not externally-sensitive like [[user]] ([[0005-id-strategy]]). The
  id is also the lookup segment of the token.
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt` (soft-delete = revoke). `tokenHash`
  is unique among **live** rows via a **partial unique index** `WHERE "deletedAt" IS NULL` (raw SQL —
  the soft-delete-reuse precedent, [[0041-soft-delete-reuse-and-restore]]).

## Fields

Prisma model `ServiceAccount` → table `service_accounts`. Validation schemas (`ServiceAccountSchema`,
`CreateServiceAccountSchema`, `UpdateServiceAccountSchema`, the once-only `ServiceAccountWithSecretSchema`)
live in `@lazyit/shared` (`packages/shared/src/schemas/service-account.ts`); none carries the secret
except the once-only reveal ([[shared-package]]).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`; also the token's lookup segment. |
| `name` | `string` | required, human-readable. |
| `description` | `string?` | optional. |
| `tokenHash` | `string` | SHA-256 of the secret; **unique among live rows** (partial unique index `WHERE "deletedAt" IS NULL`). Never the cleartext. |
| `tokenPrefix` | `string` | short non-secret prefix for display (e.g. in the list). |
| `isActive` | `boolean` | `@default(true)`; disable without deleting. |
| `expiresAt` | `datetime?` | optional expiry (no forced expiry v1); a past value → 401. |
| `lastUsedAt` | `datetime?` | updated on a successful auth (last-seen). |
| `createdById` | `uuid?` | optional FK → [[user]] (`@db.Uuid`), `onDelete: SetNull`. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete = revoke ([[0006-soft-delete-and-auditing]], [[0041-soft-delete-reuse-and-restore]]). |

## Endpoints

`apps/api/src/service-accounts/` (`ServiceAccountsModule`), all `@RequirePermission('settings:manage')`
(ADMIN-only in the seed):

- `POST /service-accounts` — create → returns the token **once** (`ServiceAccountWithSecretSchema`).
- `GET /service-accounts` — list (`?includeRevoked`).
- `GET /service-accounts/:id` — detail (no secret).
- `PATCH /service-accounts/:id` — rename / description / permissions / `isActive` / `expiresAt`.
- `POST /service-accounts/:id/rotate` — new secret **once**; old invalidated.
- `DELETE /service-accounts/:id` — soft-delete = revoke.
- `POST /service-accounts/:id/restore` — un-revoke.

Every mutation appends a [[service-account-audit-log]] row.

**Guard:** the `JwtAuthGuard` **SA branch runs BEFORE the OIDC/shim branches** — a `Bearer lzit_sa_…`
token sets `request.principal = {kind:'service', serviceAccount, permissions}` (leaving `request.user`
undefined); humans now also get `request.principal = {kind:'human', user}`. The permission guard
authorizes the SA by its direct grant Set (fail-closed). `ActorService.resolveActor(principal)` maps the
unified principal to the right audit actor column.

**Web:** `settings/service-accounts` — create / list / rotate / edit / revoke / restore, with the
**one-time secret reveal** on create + rotate (the token is never refetchable); gated on
`settings:manage` ([[0048-service-accounts]]).

> [!note] By-design boundaries (deferred / out of scope)
> - **SA-authored articles are rejected (403).** `Article.authorId` is a non-null [[user]] FK and the
>   author-only edit gate is `User`-identity equality, so a service account cannot author/own an
>   [[article]]; the [[article-version]]/[[article-link]] write paths reject an SA principal rather than
>   write a null-attributed row ([[INVARIANTS]] INV-SA-4).
> - **[[service-account-audit-log]] has no SA actor column** — an SA that self-manages SAs records
>   `actorId = null` (honest); adding an SA actor column there is a future ADR/migration.
> - **Zitadel machine-user mirror deferred** — the IdP seam stays open; BYOI no-ops (a future ADR).

Related: [[service-account-permission]] · [[service-account-audit-log]] · [[user]] · [[role-permission]] ·
[[shared-package]] · [[0048-service-accounts]] · [[0046-roles-permissions-v2]] ·
[[0043-zitadel-source-of-truth]] · [[0041-soft-delete-reuse-and-restore]] · [[0005-id-strategy]] ·
[[0006-soft-delete-and-auditing]] · [[INVARIANTS]]
