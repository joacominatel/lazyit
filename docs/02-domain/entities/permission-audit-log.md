---
title: PermissionAuditLog
tags: [domain, entity, auth, authz, audit, permissions]
status: accepted
created: 2026-06-03
updated: 2026-06-03
---

# PermissionAuditLog

> 🟢 implemented · Area: Auth / AuthZ · see [[0046-roles-permissions-v2]]

## Purpose

An **append-only** record of every change to the editable [[role-permission]] matrix — one immutable
row per permission **granted to** or **revoked from** an editable role (MEMBER / VIEWER). It is the
"who changed which role's powers, when?" trail for the configurable-permissions surface
([[0046-roles-permissions-v2]] P5), satisfying auditability-by-default
([[0006-soft-delete-and-auditing]]).

## Relationships

- **records** a change to a [[role-permission]] mapping (a `(role, permission)` grant or revoke).
- **attributed to** an optional [[user]] actor (`actorId` → `users`, `onDelete: SetNull`) — the ADMIN
  who edited the matrix. `null` = system / unknown.

## Business rules

- **Append-only and immutable.** Rows are written, never updated or deleted
  ([[0006-soft-delete-and-auditing]]). The [[role-permission]] row itself carries no history; this log
  is where the trail lives.
- **One row per change.** `PUT /config/permissions` diffs the desired MEMBER/VIEWER sets against the
  current rows; each revoked row is `REVOKE`-logged and each granted row `GRANT`-logged, all inside the
  same `$transaction` as the matrix write — so the audit trail and the live matrix can never diverge.
- **No secret, no permission leak.** The log records *which* permission moved for *which* role, not any
  credential. ADMIN is never logged here (its set is immutable/full — it is never edited).

## Conventions

- **ID:** `autoincrement()` — a log entity, never exposed externally ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `PermissionAuditLog` → table `permission_audit_logs`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | `autoincrement()` — log id ([[0005-id-strategy]]). |
| `role` | `Role` | the edited role — `MEMBER` or `VIEWER` (ADMIN is immutable, never logged). |
| `permission` | `string` | the catalog literal that was granted/revoked. |
| `action` | enum | `GRANT` \| `REVOKE`. |
| `actorId` | `uuid?` | optional FK → [[user]] (`@db.Uuid`), `onDelete: SetNull` — the editing ADMIN. |
| `createdAt` | `datetime` | `@default(now())`. |

## Emission

Written by `apps/api/src/config/permissions-config.service.ts` inside the `PUT /config/permissions`
transaction (one row per granted/revoked permission). On commit `PermissionResolverService.invalidate()`
drops the resolver cache so the next authZ decision re-reads the DB.

Related: [[role-permission]] · [[user]] · [[service-account-audit-log]] ·
[[0046-roles-permissions-v2]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
