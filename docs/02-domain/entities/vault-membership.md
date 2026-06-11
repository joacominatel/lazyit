---
title: VaultMembership
tags: [domain, entity, secret-manager, security, secrets, crypto]
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# VaultMembership

> ⚪ planned · Area: Secret Manager · Implementation order: tbd

## Purpose

Records that a [[user]] is a **crypto member** of a [[secret-vault]]. The row's load-bearing payload is
**the vault DEK wrapped to that member's public key** ([[user-keypair]]) — the only form in which a copy
of the DEK exists. Holding this row (and the matching private key) is what lets a member **decrypt** the
vault; it is the **second, orthogonal** layer beneath the `secret:read` / `secret:manage` capability that
merely lets a user *enter* the Secret Manager ([[0061-secret-manager-zero-knowledge]], INV-10).

## Relationships

- **belongs to** one [[secret-vault]] (`vaultId`, required FK).
- **belongs to** one [[user]] (`userId`, required FK → the uuid `User`).
- pairs with the member's [[user-keypair]] — the public key the DEK is wrapped **to**, the private key
  that **unwraps** it.

## Business rules

- **The row carries the wrapped DEK, never the clear DEK (INV-10).** The DEK copy is encrypted to the
  member's public key; the server stores the wrapped blob and can **never** unwrap it. No plaintext DEK is
  ever persisted or logged ([[0031-logging-strategy]]).
- **Granting = wrapping, with no escalation.** A member is added by wrapping the existing DEK to their
  public key — which requires the granter to **already** be able to unwrap it (**no grant-what-you-can't-read**).
- **Soft-revoke v1 = DROP the row.** Revoking membership **deletes** the row so the member's wrapped DEK
  copy no longer exists; there is no soft-delete tombstone for v1 (a current-state join).
- **Re-wrap on peer-reset.** When a member's [[user-keypair]] is replaced (password loss / peer-reset),
  surviving members re-wrap the DEK to the member's **new** public key, updating the row (hence the
  optional `updatedAt`).

## Conventions

- **ID:** `cuid()` — a current-state join ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` (a current-state join, not append-only audit, not soft-deletable);
  **`updatedAt` only if** the row is re-wrapped on peer-reset ([[0006-soft-delete-and-auditing]]).
- **Uniqueness:** at most one live membership per `(vaultId, userId)` — a raw-SQL **PARTIAL** unique
  index ([[0041-soft-delete-reuse-and-restore]] pattern), never a PSL `@unique`.
- **Soft-revoke v1 = hard DROP** of the row (above); no `deletedAt` in v1.

## Not yet implemented

Planned, not built. Full detail — wrap/unwrap mechanics, peer-reset re-wrapping, and the revoke model —
lives in [[0061-secret-manager-zero-knowledge]].

Related: [[secret-vault]] · [[secret-item]] · [[user-keypair]] · [[user]] · [[workflow-secret]] ·
[[0061-secret-manager-zero-knowledge]] · [[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0031-logging-strategy]] · [[INVARIANTS]]
