---
title: SecretAuditLog
tags: [domain, entity, secret-manager, security, audit, append-only]
status: accepted
created: 2026-06-13
updated: 2026-06-23
---

# SecretAuditLog

> ✅ built (#366) · Area: Secret Manager · Append-only audit log

## Purpose

An **append-only audit log** of Secret Manager actions (ADR-0061 §10). Records **metadata only** —
*who* acted on *which* vault/item/target — **NEVER a secret value, a key (wrapped or unwrapped), a
DEK, a passphrase, or a recovery key**. This is the zero-knowledge twin of the pattern established by
`PermissionAuditLog` and `ServiceAccountAuditLog`: the audit trail proves accountability without
compromising the zero-knowledge guarantee.

## Relationships

- **belongs to** one [[user]] (the actor, `actorId` FK → uuid `User`, `onDelete: SetNull`). The log
  row **survives the actor's deletion** (`SetNull`): the metadata record must outlive the actor, so
  `actorId = null` means "deleted user" or "system". This mirrors the notification-bell soft-target
  precedent (and `PermissionAuditLog`/`ServiceAccountAuditLog`).
- References `vaultId`, `itemId`, and `targetUserId` as **plain `String?` columns (NO FK)** — the
  audit row must survive even if the referenced vault, item, or user is later removed. The
  notification-bell soft-target precedent applies here.

## Business rules

- **Append-only (ADR-0006).** Rows are only ever `INSERT`ed — never `UPDATE`d, never deleted. No
  `updatedAt`, no `deletedAt`. The `createdAt` timestamp is the event time.
- **Metadata only, zero-knowledge.** The columns record WHO acted and on WHICH entity — never a
  secret value, key, blob, passphrase, or recovery key. Logging any of those would break INV-10.
- **`actorId = null` is valid** and means the actor was deleted after the event, or the action was
  system-initiated.
- The log is indexed on `vaultId` (per-vault audit timeline) and `createdAt` (newest-first / retention
  age scans).

## Columns (as built)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `Int` — autoincrement() | PK — a log/history table, never exposed externally ([[0005-id-strategy]]). |
| `action` | `SecretAuditAction` enum | One of: `VAULT_CREATED`, `VAULT_DELETED`, `ITEM_CREATED`, `ITEM_UPDATED`, `ITEM_DELETED`, `MEMBERSHIP_GRANTED`, `MEMBERSHIP_REVOKED`, `KEYPAIR_CREATED`, `KEYPAIR_RESET`, `PASSWORD_CHANGED`, `ITEMS_EXPORTED`. (`RECOVERY_KEY_REGENERATED` is DORMANT — left in the enum but no longer written, ADR-0066.) `ITEMS_EXPORTED` (#612) records a vault secret EXPORT: decryption + the `.env`/JSON build happen entirely client-side (INV-10), so this row is metadata-only — WHO exported WHICH vault, when, never a value. |
| `actorId` | `String?` (`@db.Uuid`) | FK → `User.id`, `onDelete: SetNull`. Null if the actor was later deleted. |
| `vaultId` | `String?` | Plain string reference (no FK) — survives vault deletion. |
| `itemId` | `String?` | Plain string reference (no FK) — survives item deletion. |
| `targetUserId` | `String?` | Plain string reference (no FK) — e.g. the user whose membership was granted/revoked. |
| `createdAt` | `DateTime` | Event timestamp. Append-only: no `updatedAt`, no `deletedAt`. |

DB table: `secret_audit_logs`. Indexed on `vaultId` and `createdAt`.

## Conventions

- **ID:** `autoincrement()` — a log table, never exposed externally ([[0005-id-strategy]]).
- **Append-only:** `createdAt` only — no `updatedAt`, no `deletedAt` ([[0006-soft-delete-and-auditing]]).
- **No FK on `vaultId`/`itemId`/`targetUserId`** — the audit trail must survive the deletion of the
  referenced entity. Same pattern as the notification-bell soft-target and `PermissionAuditLog`.

Related: [[secret-vault]] · [[secret-item]] · [[vault-membership]] · [[user]] ·
[[0061-secret-manager-zero-knowledge]] · [[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] ·
[[0031-logging-strategy]] · [[INVARIANTS]]
