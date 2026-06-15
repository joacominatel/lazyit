---
title: "ADR-0065: Secret Manager — regenerate the recovery key for an existing keypair"
tags: [adr, secrets, security, crypto, recovery, knowledge-base]
status: accepted
created: 2026-06-14
updated: 2026-06-15
deciders: [Joaquín Minatel]
---

# ADR-0065: Secret Manager — regenerate the recovery key for an existing keypair

## Status

**accepted** — 2026-06-15 (CEO sign-off on Option 2). Issue #452 — the deferred "regenerate" half.
It is a **bounded extension** of [[0061-secret-manager-zero-knowledge]]: a new client flow + a small
ciphertext-custodian endpoint that lets a user **re-mint their off-host recovery key without changing
their keypair**, preserving INV-10 end to end.

Two CEO resolutions bind the implementation slice (they refine the §2 "proposal" wording without
changing the contract):

1. **Endpoint shape — `POST /secret-manager/keypair/recovery`.** The narrow, self-only route is
   confirmed over the `PATCH …/keypair/me` equivalent floated in §2, precisely to signal "narrow
   recovery-blob replacement, NOT a keypair reset".
2. **Passphrase is always required.** The regenerate flow **always re-derives the private key via the
   passphrase** (§3 step 2) — even inside an already-unlocked session, the client must drive the
   re-wrap through a fresh passphrase unlock rather than reusing a cached private key. This is a
   **client concern** (the server is a pure ciphertext custodian and never sees the passphrase), but
   it is the invariant the flow is built on.

The implementation lands on `feat/issue-452-regenerate-recovery-key` (backend slice: the shared DTO,
the endpoint + service, the `RECOVERY_KEY_REGENERATED` audit action + migration, and the INV-10 guard
extension; the frontend "regenerate recovery key" flow is a later wave).

## Context

The Secret Manager ([[0061-secret-manager-zero-knowledge]]) is zero-knowledge: the server **never**
holds a key that decrypts a secret value (INV-10, [[INVARIANTS]]). Each [[user]] has **one**
[[user-keypair]] whose private key is **double-wrapped** — two independent encryptions of the *same*
private key, so either credential alone can unlock it:

- **Copy A — passphrase wrap.** `privateKeyEncByPassphrase` + `passphraseSalt` + `passphraseIv` +
  `kdfParams`, where the wrapping key is `Argon2id(vault passphrase)` (a memory-hard KDF; the
  passphrase is a Secret-Manager-only secret, **not** the OIDC login password — §3 of ADR-0061).
- **Copy B — recovery wrap.** `privateKeyEncByRecovery` + `recoverySalt` + `recoveryIv`, where the
  wrapping key is `HKDF-SHA256(recovery-key bytes)` over a high-entropy, client-generated
  **recovery key** in the format `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (Crockford-base32, ~125 bits). The
  recovery key is **shown ONCE** at bootstrap/reset and **never** persisted or logged in clear
  ([[0048-service-accounts]] shown-once precedent; [[secret-manager-crypto-design]] for the concrete
  primitives).

Both copies are minted client-side and posted only as **wrapped ciphertext**. Today there are exactly
two write paths to that keypair (verified in `apps/api/src/secret-manager/keypair.controller.ts` +
`secret-manager.service.ts`):

- **Bootstrap** — `POST /secret-manager/keypair` (`createMyKeypair`) — first-time creation; 409 if a
  live keypair already exists.
- **Reset / peer-reset** — `PUT /secret-manager/keypair/me` (`resetMyKeypair`) — mints a **NEW** keypair
  (new public key, both wrapped blobs, a fresh recovery key). This is the §6 peer-reset entry point:
  it **changes the public key**, so **every** [[vault-membership]] the user held is now wrapped to a
  **dead** public key and a peer must **re-wrap** each vault's DEK to the new key before access returns.

### The gap (#452)

A user who **loses their recovery key but still has their passphrase** has **no sanctioned path to
mint a new recovery key**. The only existing recourse is `PUT /secret-manager/keypair/me`, which is a
sledgehammer: it rotates the entire keypair and **loses all vault access** until peers re-wrap every
membership — a destructive, churny operation to fix a *non-destructive* problem. The CEO hit exactly
this framing in QA.

lazyit is **self-hosted with no support desk**. There is no operator who can "reset the recovery key"
server-side — by INV-10 the server holds no key over the value, so it *cannot*. The only honest
recovery path is **client-side, driven by the user who still holds a working credential** (the
passphrase). Without this ADR, the product nudges users to keep a recovery key (ADR-0061 §6
`[!danger]`) but gives them no way to **replace** one they have lost — leaving the keypair one
passphrase-loss away from peer-reset (or, for a single-member vault, permanent loss).

The forces: restore the user's off-host second unlock path; do it **without** churning the public key,
the per-vault DEKs, or any membership; and stay **strictly** within the zero-knowledge contract — the
server must remain a ciphertext custodian that never sees a private key or a recovery key.

## Considered options

- **Option 1 — Do nothing; recovery-key loss requires peer-reset.** *Rejected.* It conflates a
  recoverable situation (passphrase intact) with the destructive peer-reset path: it rotates the
  keypair, invalidates every membership, and forces N peer re-wraps to fix what should be a one-blob
  re-mint. For a **single-member** vault it is worse than the problem — peer-reset there is itself
  unrecoverable (no peer to re-wrap), so "lost recovery key only" would escalate to "lost the vault".
  Leaves the only-sanctioned-DR-artifact unreplaceable in a no-support-desk product.

- **Option 2 — Regenerate ONLY the recovery wrap, keypair unchanged (CHOSEN).** The client unlocks the
  private key **with the passphrase** (in the browser), mints a **new** recovery key, and **re-wraps
  only the recovery-key-wrapped blob** (`privateKeyEncByRecovery` + `recoverySalt` + `recoveryIv`). The
  passphrase-wrapped blob, the **public key**, the per-vault **DEKs**, and **every membership** are
  untouched. A new, narrow endpoint **replaces** the recovery blob; the new key is shown once. **No DEK
  re-wrap, no membership churn, INV-10 preserved.** This is the surgical fix for "lost recovery key,
  kept passphrase".

- **Option 3 — Delete-own-vault + recreate.** *Rejected.* INV-10-neutral (it touches no server-held
  key), but it is no recovery power at all: it **weakens durability** (soft-deletes the vault and its
  items, losing history) and does nothing for the user's *keypair* recovery artifact. It solves a
  different, more destructive problem and leaves the recovery key still unreplaceable.

- **Option 4 — Encrypted export/import of the keypair (a "key backup file").** *Rejected.* It adds
  **attack surface** with no power the passphrase-unlock path doesn't already give: a user who can
  unlock with the passphrase can already re-wrap. An exported, passphrase-encrypted keypair file is a
  portable, **offline brute-force target** — a low-entropy passphrase that is acceptable for an online
  unlock becomes a liability once an attacker has the file in hand. It also invents a second artifact to
  store off-host (the very thing the recovery key already is), doubling the loss surface. The
  recovery key (high-entropy, ~125 bits) is a *better* off-host artifact than an exported file.

**Chosen: Option 2.** Re-mint the recovery wrap in place; never touch the keypair, DEKs, or memberships.

## Decision

### 1. Regenerate the recovery key without changing the keypair

A user who can still unlock with their **passphrase** may mint a **new recovery key** and re-wrap their
**existing** private key under it. This is a **recovery-wrap re-mint**, NOT a keypair reset:

| | Bootstrap (`POST`) | Reset / peer-reset (`PUT …/me`) | **Regenerate recovery (this ADR)** |
| --- | --- | --- | --- |
| Keypair (public key) | created | **rotated (new)** | **unchanged** |
| Passphrase-wrapped blob | written | rewritten | **untouched** |
| Recovery-wrapped blob | written | rewritten | **rewritten (only this)** |
| Per-vault DEKs | n/a | unchanged on-disk, but unreachable until re-wrap | **unchanged & still reachable** |
| Memberships | n/a | **all dead → need peer re-wrap** | **all intact, no churn** |
| Recovery key shown once | yes | yes | **yes** |

Because the **public key is unchanged**, every [[vault-membership]] blob (a DEK wrapped to that public
key) still unwraps with the same private key. There is **no DEK re-wrap** and **no membership churn** —
the decisive advantage over peer-reset.

### 2. Endpoint shape (confirmed)

A new, narrow, **self-only** write that **replaces** the recovery-key-wrapped blob and nothing else.
The CEO confirmed `POST /secret-manager/keypair/recovery` (Status resolution 1):

```
POST /secret-manager/keypair/recovery        (self-only; principal from the auth context)

request body (all base64 unless noted; same shape discipline as the existing keypair DTOs):
{
  privateKeyEncByRecovery: string   // NEW recovery-wrapped private-key blob (ciphertext‖tag)
  recoverySalt:            string   // NEW HKDF salt for the recovery wrap
  recoveryIv:              string   // NEW AEAD IV for the recovery wrap
}

server behaviour:
- requires an EXISTING live UserKeypair for the caller (404/409 if none — this is not bootstrap)
- updates ONLY privateKeyEncByRecovery / recoverySalt / recoveryIv on that row; bumps updatedAt
- leaves publicKey, privateKeyEncByPassphrase, passphraseSalt, passphraseIv, kdfParams UNTOUCHED
- audits a new RECOVERY_KEY_REGENERATED event (metadata only — who/when/which keypair; never the key)
- HumanOnlyGuard + the same `secret:read` capability gate as the other keypair routes
```

> The verb/path is **confirmed** (Status resolution 1): `POST …/keypair/recovery` over an unscoped
> `PUT …/me` precisely to signal "narrow recovery-blob replacement, NOT a keypair reset". A
> `PATCH …/keypair/me` over the three recovery columns was an acceptable equivalent, but the CEO chose
> the explicit `POST …/recovery`; either way the binding contract is **"replace only the recovery wrap;
> touch nothing else"**.

### 3. Client flow (all crypto in the browser; reuse the existing primitives)

Mirrors bootstrap's shown-once discipline, minus the keypair generation and the passphrase wrap:

1. **Fetch** the caller's keypair (`GET /secret-manager/keypair/me`).
2. **Unlock with the passphrase** — `unlockWithPassphrase(keypair, passphrase)` (Argon2id →
   `openBytes`), yielding the **plaintext private key in memory** (browser only). *(The recovery key is
   not required and is, by hypothesis, lost.)*
3. **Mint a new recovery key** — `generateRecoveryKey()` → `{ display, bytes }`.
4. **Re-wrap** the already-unlocked private key — fresh `recoverySalt` → `deriveRecoveryWrapKey(bytes,
   salt)` → `sealBytes(key, privateKey)` → `joinSealedBlob(...)` → `{ privateKeyEncByRecovery,
   recoverySalt, recoveryIv }`.
5. **POST** the new recovery-wrapped blob to **replace** the old one (§2).
6. **Show the new recovery key ONCE** in the non-dismissible `RecoveryKeyModal`, gated on the explicit
   "I've saved it" acknowledge — **reusing the post-acknowledge persistence ordering hardened in #452 /
   PR #457**: the new blob is committed, then the key is shown once and the acknowledge clears it from
   state; the key is never re-fetchable. On the modal's appearance the **old** recovery key is already
   dead (its salt/iv have been overwritten server-side), so there is no window in which two valid
   recovery keys coexist after acknowledge.

No new shared crypto is needed — `unlockWithPassphrase`, `generateRecoveryKey`, `deriveRecoveryWrapKey`,
`sealBytes`/`joinSealedBlob` (in `packages/shared/src/crypto/` and `apps/web/lib/secret-manager/`) are
exactly the bootstrap building blocks, re-composed.

### AuthZ — self-only

A user regenerates their **OWN** recovery key. There is **no admin-acting-on-another-user** variant:
an admin cannot mint a recovery key for someone else because it would require unlocking that user's
private key, which the admin (and the server) cannot do. This is INV-8's exact boundary — ADMIN
omnipotence is over **authorization/visibility**, **never** cryptographic plaintext (INV-10). The
endpoint derives the target keypair from the authenticated principal only.

### What is NOT solved (by design)

**Lost BOTH the passphrase AND the recovery key on a single-member vault is still permanent loss.**
This ADR's entry condition is *"passphrase intact"* — it cannot help a user who has lost both
credentials, because the client has nothing to unlock the private key with. For such a user the
existing paths apply: **peer-reset** ([[0061-secret-manager-zero-knowledge]] §6) if the vault has
another member, else **permanent, irrecoverable loss** (§6 `[!danger]`). That is the inherent
durability/zero-knowledge tradeoff, stated plainly — this ADR widens the recoverable region (it makes
"lost recovery key only" a one-click, non-destructive fix) but **does not** add a back door.

## Security & invariants

- **INV-10 is preserved end to end.** The server only ever stores **ciphertext** — it receives the new
  `privateKeyEncByRecovery`/`recoverySalt`/`recoveryIv`, writes them, and audits metadata. It **never**
  sees the private key, the passphrase, or the recovery key (old or new). There is **no** server-side
  `reveal()` and **no** env master key — identical custody to bootstrap/reset. INV-8's
  authorization-not-plaintext boundary is untouched (self-only; no admin override).
- **Server cannot validate the new blob.** As with bootstrap/reset, the server **cannot verify** that
  the posted blob actually decrypts to the user's private key — correctness is the **client's
  responsibility** (the same trust model the existing two write paths already accept). A malformed or
  malicious client could write a recovery blob that unlocks nothing; the **threat model is unchanged
  from bootstrap/reset**, and the failure mode is self-inflicted (the user's *own* future
  recovery-key unlock fails) — it cannot harm other users or leak plaintext. The blob shape/size
  validation (base64, max length) carries over from the existing keypair DTOs.
- **No new attack surface beyond the existing keypair writes.** One additional self-only,
  capability-gated, human-only write; no new key custody; no plaintext on a wire shape; no new logged
  field (the audit row is metadata-only per [[0031-logging-strategy]]).
- **🚩 Flag for `lazyit-sentinel` at implementation time.** Although the model is INV-10-clean by
  construction, this touches the crypto-critical keypair surface. The implementation slice must include
  the threat review: confirm self-only enforcement (no `:userId` variant), confirm the endpoint
  **cannot** be used as a bootstrap (must require a live keypair), confirm it writes **only** the three
  recovery columns (never the passphrase wrap or public key), and extend the **INV-10 architectural
  guard test** (`apps/api/src/secret-manager/inv-10.guard.spec.ts`) to cover the new route (no crypto
  import, no `*_KEY` env, no plaintext return). The shown-once + post-acknowledge ordering must be
  asserted (reuse the #452 / PR #457 hardening, do not re-derive it).

## Consequences

- **Positive:**
  - **Restores the off-host second unlock path** for the common, recoverable case ("lost the recovery
    key, still have the passphrase") — the only sanctioned recovery in a no-support-desk product.
  - **Non-destructive and churn-free:** keypair, DEKs, and all memberships are untouched — no peer
    re-wrap, no `secret:manage` coordination, unlike peer-reset.
  - **INV-10-clean and minimal surface:** one self-only, human-only, capability-gated ciphertext write;
    no new crypto, no new key custody — it re-composes the existing bootstrap primitives.
  - **Shrinks the permanent-loss window:** a single-member vault is now one passphrase-loss (not one
    *credential*-loss) from peril, because the recovery key is replaceable while the passphrase holds.
- **Negative / trade-offs (accepted):**
  - **Does not cover "lost both" on a single-member vault** — still permanent loss (by design; the
    zero-knowledge cost, unchanged).
  - **Server cannot validate the new blob** — correctness is the client's job (same as bootstrap/reset;
    threat model unchanged).
  - **A third keypair write path to audit** — small and INV-10-clean, but it must be covered by the
    INV-10 guard test and a `lazyit-sentinel` pass (flagged above).
- **Follow-ups:**
  - **Implementation slice (future task, gated on this ADR's acceptance):** the new self-only endpoint
    (`POST /secret-manager/keypair/recovery` or the `PATCH` equivalent) + shared DTO/zod for the
    recovery-blob payload + the client "regenerate recovery key" flow and its reuse of the
    `RecoveryKeyModal` + the new `RECOVERY_KEY_REGENERATED` audit event + INV-10-guard extension +
    `lazyit-sentinel` review.
  - **Manual / help surface** ([[0062-in-app-help-manual-surface]]) — the Secret Manager "what is the
    recovery key / how it works" page should explain regenerate-vs-reset (keep your passphrase →
    regenerate; lost both → peer-reset) so users pick the non-destructive path.
  - **[[user-keypair]] entity note** — add the regenerate path to the keypair lifecycle (bootstrap →
    unlock → regenerate-recovery → reset) once built.

**Related:** [[0061-secret-manager-zero-knowledge]] · [[secret-manager-crypto-design]] ·
[[0048-service-accounts]] · [[0046-roles-permissions-v2]] · [[0031-logging-strategy]] ·
[[user-keypair]] · [[vault-membership]] · [[secret-vault]] · [[user]] · [[INVARIANTS]] (INV-8 / INV-10)
