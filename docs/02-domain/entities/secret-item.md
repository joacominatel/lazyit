---
title: SecretItem
tags: [domain, entity, secret-manager, security, secrets, crypto]
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# SecretItem

> ⚪ planned · Area: Secret Manager · Implementation order: tbd

## Purpose

A single **secret value inside a [[secret-vault]]** — a password, API key, or note. It stores **only the
ciphertext** of the value encrypted under the vault's DEK; the plaintext is **zero-knowledge** (proposed
**INV-10**) and is never visible to the server. Decryption happens **client-side** after the member
unwraps the vault DEK with their own [[user-keypair]]. The crypto column shape mirrors the
[[workflow-secret]] envelope — but where `WorkflowSecret` is **server-decryptable by design** (ADR-0054,
so connectors can authenticate at run time), a `SecretItem` value is **never** server-readable (see the
disambiguation in [[0061-secret-manager-zero-knowledge]]).

## Relationships

- **belongs to** one [[secret-vault]] (required FK) — the vault whose DEK encrypts this value.
- non-secret metadata (a label/title) may be stored in clear for listing; the **value** is ciphertext only.

## Business rules

- **Zero-knowledge value (INV-10).** The row holds **only** the encrypted value: `ciphertext` / `iv` /
  `authTag` / `keyVersion` (base64 text, mirroring [[workflow-secret]]). The server stores no plaintext,
  no key that can decrypt it, and offers **no server-side reveal**. Decryption is client-side under the
  unwrapped vault DEK.
- **Crypto columns are write-only and redacted on read.** The ciphertext/iv/authTag/keyVersion are
  **never returned** on a normal read shape and **never logged** ([[0031-logging-strategy]]); a read
  exposes only non-secret metadata + the encrypted blob to the *member* client that will decrypt it,
  never the plaintext to the server.
- **No re-encryption without the DEK.** Because the value is wrapped under the vault DEK, the server
  cannot re-key or migrate a value's plaintext; `keyVersion` tracks which DEK/version produced the
  envelope.
- **Access is mediated by the vault.** There is no per-item ACL — a member who can unwrap the vault DEK
  ([[vault-membership]]) can decrypt every item in it; entry is additionally gated by the planned
  `secret:read` capability.

## Conventions

- **ID:** `cuid()` — a mutable domain entity ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt` (mutable domain,
  [[0006-soft-delete-and-auditing]]).
- **Crypto columns** mirror [[workflow-secret]]: `ciphertext` / `iv` / `authTag` / `keyVersion` as base64
  text — at-rest only, never on a wire shape, never logged ([[0031-logging-strategy]], INV-10).

## Not yet implemented

Planned, not built. Full detail — the exact envelope, client-side decrypt flow, and item lifecycle —
lives in [[0061-secret-manager-zero-knowledge]].

Related: [[secret-vault]] · [[vault-membership]] · [[user-keypair]] · [[workflow-secret]] ·
[[0061-secret-manager-zero-knowledge]] · [[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] ·
[[0031-logging-strategy]] · [[INVARIANTS]]
