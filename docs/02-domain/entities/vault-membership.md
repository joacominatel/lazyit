---
title: VaultMembership
tags: [domain, entity, secret-manager, security, secrets, crypto]
status: accepted
created: 2026-06-11
updated: 2026-06-13
---

# VaultMembership

> ✅ built (#366) · Area: Secret Manager · Under the "Conocimiento" pillar

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
- **Offboarding hard-drops ALL of a user's memberships (#869).** Offboarding a [[user]]
  (`UsersService.remove`) revokes every one of that user's memberships **inside the same offboard
  transaction** — a `deleteMany({ where: { userId } })`, the bulk twin of the single revoke above — so a
  departed user never keeps a wrapped-DEK copy (a SOC2 offboarding-control gap otherwise). Still
  **INV-10-safe**: a pure row-delete, no decryption. Because lazyit **cannot auto-rotate** (it can't
  re-encrypt), the offboard result also returns a **rotation flag** — the affected vaults' name + live
  secret count (pure metadata), read **before** the delete — as an informational prompt to rotate those
  secrets by hand. Audit parity: one `MEMBERSHIP_REVOKED` [[secret-audit-log]] row per revoked vault,
  same human-XOR-SA actor mapping as the grant revocation ([[0049-activated-restraint-ux-direction]]
  #869 note; [[0048-service-accounts]]).
- **Re-wrap on peer-reset.** When a member's [[user-keypair]] is replaced (password loss / peer-reset),
  surviving members re-wrap the DEK to the member's **new** public key, updating the row (hence the
  optional `updatedAt`).

## Conventions

- **ID:** `cuid()` — a current-state join ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` + `updatedAt` (re-wrap on peer-reset updates the row in place —
  [[0006-soft-delete-and-auditing]]). **NO `deletedAt`** — v1 revoke is a HARD DROP of the row.
- **Uniqueness:** a **PLAIN PSL `@@unique([vaultId, userId])`** — correct here because there is no
  soft-delete to ghost-row-exclude ([[0041-soft-delete-reuse-and-restore]]). This is the deliberate
  exception to the partial-index pattern used by `SecretVault` and `SecretItem`.
- **Soft-revoke v1 = hard DROP** of the row — the wrapped-DEK copy ceases to exist.
  Hard revoke (DEK rotation) is deferred to Phase 2 (accepted debt, ADR-0061 §5).

## Columns (as built)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `String` — cuid() | Primary key. |
| `vaultId` | `String` | FK → `SecretVault.id`, `onDelete: Cascade` — a (hard-deleted) vault drops its memberships. |
| `userId` | `String` (`@db.Uuid`) | FK → `User.id`, `onDelete: Cascade` — a hard-deleted user drops their wrapped-DEK copy. |
| `ephemeralPublicKey` | `String` (base64) | The ephemeral X25519 public key from the wrap operation. |
| `wrapNonce` | `String` (base64) | 12-byte AES-GCM nonce used to wrap the DEK. |
| `wrappedDek` | `String` (base64) | The vault DEK wrapped (ECIES-style over X25519 + HKDF + AES-256-GCM) to this member's public key. |
| `wrapVersion` | `Int` (default 1) | Forward-compat seam mirroring `SecretItem.keyVersion` — for the deferred DEK rotation. |
| `createdAt` | `DateTime` | Set on insert (when member was granted). |
| `updatedAt` | `DateTime` | Updated in place on a peer-reset re-wrap. |

DB table: `vault_memberships`. Indexed on `userId`. Plain `@@unique([vaultId, userId])`.

## Implementation status

**Fully built (#366).** Grant (client-side re-wrap → POST membership row) and revoke (DELETE membership
row, hard) are implemented in the custodian backend. Peer-reset re-wrap (PUT membership row) is wired
in the frontend. Full crypto detail: [[secret-manager-crypto-design]] §2.

Related: [[secret-vault]] · [[secret-item]] · [[user-keypair]] · [[user]] · [[workflow-secret]] ·
[[0061-secret-manager-zero-knowledge]] · [[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0031-logging-strategy]] · [[INVARIANTS]]
