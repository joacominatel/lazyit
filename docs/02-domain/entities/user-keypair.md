---
title: UserKeypair
tags: [domain, entity, secret-manager, security, secrets, crypto]
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# UserKeypair

> ⚪ planned · Area: Secret Manager · Implementation order: tbd

## Purpose

One **keypair per [[user]]** — the identity the [[0061-secret-manager-zero-knowledge|Secret Manager]] wraps
vault DEKs to. The **public key** is stored in clear (so DEKs can be wrapped to it); the **private key** is
stored **encrypted under `Argon2id(vault passphrase)`** (a per-user Secret-Manager unlock secret,
**distinct from the OIDC login password**, which lazyit never receives) and, separately, **wrapped a
second time under a recovery key** so a member who loses their vault passphrase can still recover. This is what makes the system zero-knowledge
(proposed **INV-10**): the server holds public material and wrapped blobs only, **never** the plaintext
private key, password, or recovery key.

## Relationships

- **belongs to** one [[user]] (1:1, ties to the uuid `User`).
- its public key is the target every [[vault-membership]] wraps a vault DEK **to**; its private key is what
  **unwraps** those DEKs.

## Business rules

- **Public key in clear; private key never in clear (INV-10).** `publicKey` is stored plainly. The
  `privateKey` is persisted **only** encrypted under `Argon2id(vault passphrase)`, plus a **second** copy
  wrapped under the **recovery key**. The server stores no plaintext private key and cannot derive one.
- **Recovery key is shown once.** Format **`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`** (5 alphanumeric groups, the
  validator planned for [[shared-package]]). It is generated client-side, **displayed exactly once** at
  keypair creation, and is **never logged or persisted in clear** ([[0031-logging-strategy]]). It is the
  user's personal, **off-host, shown-once DR artifact** — the operator cannot back it up for them
  ([[backups]]).
- **Vault-passphrase change re-wraps, doesn't re-key.** Changing the vault passphrase re-encrypts the
  **private key** under the new `Argon2id(vault passphrase)`; the keypair itself (and every wrapped DEK
  pointing at the public key) is unchanged. An **IdP-side login-password reset does NOT touch the vault
  envelope** (and vice-versa) — the lazyit vault passphrase and the IdP credential are independent.
- **Peer-reset replaces the keypair.** If a user loses **both** vault passphrase and recovery key, recovery is a
  **peer-reset**: a new keypair is issued and surviving vault members **re-wrap** each DEK to the new
  public key ([[vault-membership]]). A **single-member** vault whose owner loses both is **permanent loss
  by design** — no server key and no ADMIN (INV-8 is over authorization, not plaintext) can recover it.

## Conventions

- **ID / attachment:** attaches **1:1 to [[user]]** (the uuid `User`, [[0005-id-strategy]]); a mutable
  entity.
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt` (mutable domain,
  [[0006-soft-delete-and-auditing]]); a peer-reset replaces the keypair.
- **Crypto columns** mirror [[workflow-secret]] discipline: wrapped/encrypted blobs as base64 text,
  write-only, **never returned, never logged** ([[0031-logging-strategy]]); `publicKey` is the only
  clear material.

## Not yet implemented

Planned, not built. Full detail — Argon2id parameters, the recovery-key derivation/wrapping, and the
peer-reset protocol — lives in [[0061-secret-manager-zero-knowledge]].

Related: [[user]] · [[secret-vault]] · [[vault-membership]] · [[secret-item]] · [[workflow-secret]] ·
[[shared-package]] · [[backups]] · [[0061-secret-manager-zero-knowledge]] · [[0005-id-strategy]] ·
[[0006-soft-delete-and-auditing]] · [[0031-logging-strategy]] · [[INVARIANTS]]
