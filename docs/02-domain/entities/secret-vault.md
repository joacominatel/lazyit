---
title: SecretVault
tags: [domain, entity, secret-manager, security, secrets, crypto]
status: accepted
created: 2026-06-11
updated: 2026-06-13
---

# SecretVault

> ✅ built (#366, #421/#422/#423) · Area: Secret Manager · Under the "Conocimiento" pillar

## Purpose

A **folder vault** — the **crypto boundary** of the [[0061-secret-manager-zero-knowledge|Secret Manager]].
Each vault owns a single random **DEK** (data-encryption key) under which every [[secret-item]] in it is
encrypted. The DEK is **never stored in clear**: the only copies that exist are per-member [[vault-membership]]
rows, each holding the DEK **wrapped to that member's public key**. The server therefore sees a vault's
**name and member list** but can **never** decrypt its contents — the zero-knowledge contract (proposed
**INV-10**). This is a different store and threat model from the server-decryptable [[workflow-secret]]
(ADR-0054); see the disambiguation in [[0061-secret-manager-zero-knowledge]].

## Relationships

- **has many** [[secret-item]]s (the encrypted values stored under this vault's DEK).
- **has many** [[vault-membership]] rows — one per crypto member, each carrying the DEK wrapped to that
  member's [[user-keypair]] public key.
- conceptually sits **beside** a Knowledge Base [[folder]] (the Secret Manager lives next to the KB,
  [[0061-secret-manager-zero-knowledge]]); access to *enter* is gated by the planned `secret:read` /
  `secret:manage` capability, while the wrapped DEK is the **second, orthogonal** layer that lets a member
  *decrypt*.

## Business rules

- **Zero-knowledge by construction (INV-10).** The server stores only the vault's **non-secret name** and
  its member list. The **DEK is never persisted in clear** — only per-member wrapped copies exist. There
  is **no server-side reveal**, no env master key over vault contents; ADMIN omnipotence (INV-8) is over
  authorization/visibility, **never** cryptographic plaintext.
- **Granting wraps, never reveals.** Adding a member wraps the existing DEK to that member's public key
  (a new [[vault-membership]] row). **No grant-what-you-can't-read**: you can only wrap a DEK you can
  yourself unwrap.
- **Soft-revoke v1 = drop the membership.** Removing a member **DROPs** their [[vault-membership]] row so
  their wrapped DEK copy ceases to exist (forward secrecy of *new* writes is organizational, not
  retroactive — note it in the ADR).
- **Two capability + crypto layers.** `secret:read` / `secret:manage` (planned, ADMIN-only by default —
  the same separation-of-duties precedent as `workflow:secrets`) lets a user **enter** the Secret Manager;
  a wrapped DEK lets them **decrypt a given vault**. Both are required.

## Conventions

- **ID:** `cuid()` — a mutable domain entity ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt` (mutable domain,
  [[0006-soft-delete-and-auditing]]).
- **Uniqueness** on this soft-deletable model (if a per-scope name uniqueness is required) is a raw-SQL
  **PARTIAL** unique index `WHERE "deletedAt" IS NULL` ([[0041-soft-delete-reuse-and-restore]]), never a
  PSL `@unique`.
- The vault row **never** carries the DEK; the wrapped DEK lives on [[vault-membership]] (mirroring how
  [[workflow-secret]] keeps crypto material off any wire shape).

## Columns (as built)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `String` — cuid() | Primary key ([[0005-id-strategy]]). |
| `name` | `String` | Server-visible, non-secret vault name. Uniqueness among **live** rows is enforced by a raw-SQL partial unique index `WHERE "deletedAt" IS NULL` in the migration — **NOT** a PSL `@unique` ([[0041-soft-delete-reuse-and-restore]]). |
| `createdAt` | `DateTime` | Set on insert. |
| `updatedAt` | `DateTime` | Updated by Prisma on every write. |
| `deletedAt` | `DateTime?` | Soft delete ([[0006-soft-delete-and-auditing]]). |

DB table: `secret_vaults`.

## Implementation status

**Fully built (#366).**

- **Data model (#421/#422):** the five tables (`SecretVault`, `SecretItem`, `VaultMembership`,
  `UserKeypair`, `SecretAuditLog`), the live-only partial-unique indexes, and the `secret:read` /
  `secret:manage` capability catalog addition.
- **Custodian backend (#423, `apps/api/src/secret-manager/`):** the ciphertext-custodian REST surface
  (`/secret-vaults` vault/item/member CRUD, `/secret-manager/keypair`, `/secret-manager/items` chip
  resolution). Enforces the **two orthogonal authz layers** (RBAC `secret:read`/`secret:manage` ⟂
  per-vault crypto membership); **human-only** (service principal rejected, `human-only.guard.ts`);
  writes metadata-only `SecretAuditLog` rows on every mutation. Ships the **INV-10 architectural guard
  test** (`inv-10.guard.spec.ts`) as a merge gate — asserts no `@noble`/crypto import, no
  `SECRET_MANAGER_KEY`, no server-side reveal in the secret-manager module.
- **Client-side crypto (`@lazyit/shared/crypto` + `apps/web`):** pure crypto primitives (X25519,
  HKDF-SHA256, AES-256-GCM envelope, Crockford-base32 recovery key, Argon2id params) ship as the
  `@lazyit/shared/crypto` subpath (ESM, no DOM/WASM — those stay in `apps/web`). The Argon2id WASM
  wrapper (`hash-wasm`) and the React unlock/reveal/grant/peer-reset UI flows live in `apps/web`.
- **Frontend (`apps/web/app/(app)/secrets/`):** vault list/create, unlock gate (passphrase → Argon2id),
  items click-to-reveal (client decrypt, auto-mask), members grant/revoke, recovery-key shown-once,
  peer-reset. Secret material kept in an in-memory session (`SecretManagerProvider` in the `(app)`
  layout — **never persisted**).
- **KB chip:** `{{ lazyit_secret.HANDLE }}` render plugin (post-sanitize, mirrors `[[slug]]`); double
  gate (article ACL INV-9 AND crypto vault membership); handle autocomplete (metadata only).

Full crypto detail: [[secret-manager-crypto-design]].

Related: [[secret-item]] · [[vault-membership]] · [[user-keypair]] · [[secret-audit-log]] ·
[[workflow-secret]] · [[folder]] · [[0061-secret-manager-zero-knowledge]] · [[0005-id-strategy]] ·
[[0006-soft-delete-and-auditing]] · [[0041-soft-delete-reuse-and-restore]] · [[0031-logging-strategy]] ·
[[INVARIANTS]]
