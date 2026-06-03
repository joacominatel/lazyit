---
title: ServiceAccountPermission
tags: [domain, entity, auth, authz, service-accounts, permissions]
status: accepted
created: 2026-06-03
updated: 2026-06-03
---

# ServiceAccountPermission

> 🟢 implemented · Area: Auth / AuthZ · see [[0048-service-accounts]]

## Purpose

The **direct authorization grants** of a [[service-account]] — the join that lists the exact
`domain:action` permission literals a bot holds ([[0048-service-accounts]] Fork #3). It is the
service-account analogue of [[role-permission]], but bound to one account rather than a `Role`: a
service account has **no role**, so its grants here are its *entire* authorization.

## Relationships

- **belongs to** one [[service-account]] (`serviceAccountId`, FK → `service_accounts`,
  `onDelete: Cascade` — a grant is meaningless without its account).
- **references** one permission literal from the SAME frozen catalog humans use
  (`PermissionSchema` in `@lazyit/shared`, [[shared-package]]) — a plain `String`, validated against the
  catalog; a catalog-foreign row is ignored at resolve time (a typo can't confer a power).

## Business rules

- **The authorization source — never a Role.** A [[service-account]] is authorized **only** by these
  grants, resolved DB-first into a Set; the role resolver (`PermissionResolverService`) is **never**
  consulted for it ([[INVARIANTS]] INV-SA-3). There is NO ADMIN / wildcard — a bot can never be
  ADMIN-equivalent.
- **Fail-closed.** A route passes only if its `@RequirePermission(...)` is **fully** contained in this
  grant Set; an unannotated, non-`@Public` route is a **403** (the SA does not inherit the human
  open-by-default — [[INVARIANTS]] INV-SA-2).
- **Edited via the account's `PATCH`.** Grants are set through `PATCH /service-accounts/:id`
  (`permissions: Permission[]`), validated against the catalog (unknown → 400); the change is audited in
  [[service-account-audit-log]] (`PERMISSION_CHANGE`).

## Conventions

- **ID:** none — the composite primary key `(serviceAccountId, permission)` is the row's identity (small
  configuration, not domain data) — same rationale as [[role-permission]].
- **Timestamps / soft delete:** **none**. The grant set is replaced via the account's `PATCH`; the trail
  of changes lives in the append-only [[service-account-audit-log]]
  ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `ServiceAccountPermission` → table `service_account_permissions`.

| Field | Type | Notes |
| --- | --- | --- |
| `serviceAccountId` | `cuid` | FK → [[service-account]], `onDelete: Cascade`; part of the composite PK. |
| `permission` | `string` | a catalog literal (`domain:action`); plain `String`, validated against `PermissionSchema` in `@lazyit/shared`; part of the composite PK. |

Related: [[service-account]] · [[role-permission]] · [[service-account-audit-log]] · [[shared-package]] ·
[[0048-service-accounts]] · [[0046-roles-permissions-v2]] · [[0006-soft-delete-and-auditing]] ·
[[INVARIANTS]]
