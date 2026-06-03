---
title: ServiceAccountAuditLog
tags: [domain, entity, auth, authz, audit, service-accounts]
status: accepted
created: 2026-06-03
updated: 2026-06-03
---

# ServiceAccountAuditLog

> 🟢 implemented · Area: Auth / AuthZ · see [[0048-service-accounts]]

## Purpose

An **append-only** record of every lifecycle action on a [[service-account]] — mint, rotate, revoke,
restore and permission changes ([[0048-service-accounts]]). It is the management trail for the bot
credential surface, satisfying auditability-by-default ([[0006-soft-delete-and-auditing]]).

> This logs **management** of a service account. The *domain* actions an SA performs (assigning an
> asset, opening a grant, …) are attributed on the audit-bearing append-only tables themselves via the
> nullable `serviceAccountId` actor column — see [[service-account]] and [[INVARIANTS]] INV-SA-4.

## Relationships

- **records** a lifecycle action on a [[service-account]] (mint/rotate/revoke/restore/permission-change).
- **attributed to** an optional [[user]] actor (`actorId` → `users`, `onDelete: SetNull`) — the ADMIN
  who performed the management action. `null` = system / unknown.

## Business rules

- **Append-only and immutable.** Rows are written, never updated or deleted
  ([[0006-soft-delete-and-auditing]]).
- **The secret is NEVER recorded.** Mint/rotate log the *event*, not the cleartext token (the cleartext
  is shown once and never persisted — [[INVARIANTS]] INV-SA-1).
- **One row per management action.** Appended in the same path as the mutation it records
  (`ServiceAccountsService`).

> [!note] No SA actor column yet (by design, a follow-up)
> The actor FK here is a [[user]] only (`actorId`). When a [[service-account]] **self-manages** service
> accounts, the action is recorded with `actorId = null` — honest (it was not a human), but it does not
> yet attribute *which* SA acted. Adding an `serviceAccountId` actor column to this table is a future
> ADR/migration ([[0048-service-accounts]] follow-up). This is the one audit table without the unified
> two-actor model the 6 domain audit tables carry ([[INVARIANTS]] INV-SA-4).

## Conventions

- **ID:** `autoincrement()` — a log entity ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `ServiceAccountAuditLog` → table `service_account_audit_logs`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | `autoincrement()` — log id ([[0005-id-strategy]]). |
| `serviceAccountId` | `cuid` | the SA being managed (the subject). |
| `action` | enum | `MINT` \| `ROTATE` \| `REVOKE` \| `RESTORE` \| `PERMISSION_CHANGE`. |
| `actorId` | `uuid?` | optional FK → [[user]] (`@db.Uuid`), `onDelete: SetNull` — the managing ADMIN; `null` when an SA self-manages (see note). |
| `detail` | `json?` | optional context (e.g. the permission delta); never the secret. |
| `createdAt` | `datetime` | `@default(now())`. |

## Emission

Written by `apps/api/src/service-accounts/service-accounts.service.ts` on every mutation
(create/rotate/revoke/restore/permission-change). The secret is never persisted nor audited.

Related: [[service-account]] · [[service-account-permission]] · [[user]] · [[permission-audit-log]] ·
[[0048-service-accounts]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
