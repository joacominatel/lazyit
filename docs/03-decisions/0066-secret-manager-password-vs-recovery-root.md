---
title: "ADR-0066: Secret Manager — password is the daily entry credential, recovery key is the root that resets it"
tags: [adr, secrets, security, crypto, recovery, knowledge-base]
status: accepted
created: 2026-06-15
deciders: [Joaquín Minatel]
---

# ADR-0066: Secret Manager — password is the daily entry credential, recovery key is the root that resets it

## Status

**accepted** — 2026-06-15 (CEO sign-off). Issue #452. A **refinement of the keypair credential model**
introduced by [[0061-secret-manager-zero-knowledge]] and adjusted by [[0065-secret-manager-regenerate-recovery-key]]:
the two unlock credentials are made **asymmetric** — the **password** (Copy A) is the daily ENTRY
credential a user can change, and the **recovery key** (Copy B) is the ROOT of trust that can only be
used to RESET the password. INV-10 is preserved end to end: the server stays a ciphertext custodian.

This ADR **supersedes [[0065-secret-manager-regenerate-recovery-key]]** (the "regenerate the recovery key
with the password" flow is reverted) and **amends [[0061-secret-manager-zero-knowledge]]** (the symmetric
"either credential unlocks directly" model becomes asymmetric entry-vs-reset).

> The backend slice lands on `feat/issue-452-password-vs-recovery-root`: the shared `ChangeKeypairPasswordSchema`
> DTO, the `POST /secret-manager/keypair/password` endpoint + `changePassword` service (re-wraps Copy A only),
> the new `PASSWORD_CHANGED` audit action + migration, and the INV-10 guard extension. The ADR-0065 backend
> surface (`POST /secret-manager/keypair/recovery`, `RegenerateRecoveryKeySchema`, `regenerateRecoveryKey`) is
> removed. The frontend wave (remove the direct-unlock-with-recovery-key entry path; wire change/reset) is later.

## Context

The Secret Manager ([[0061-secret-manager-zero-knowledge]]) is zero-knowledge: the server **never** holds a
key that decrypts a secret value (INV-10, [[INVARIANTS]]). Each [[user]] has **one** [[user-keypair]] whose
X25519 private key is **double-wrapped** — two independent AES-256-GCM wrappings of the *same* private key:

- **Copy A — password wrap.** `privateKeyEncByPassphrase` + `passphraseSalt` + `passphraseIv` + `kdfParams`,
  wrapping key `Argon2id(password)`. A Secret-Manager-only secret, **not** the OIDC login password
  (lazyit never receives the login credential — ADR-0061 §3).
- **Copy B — recovery wrap.** `privateKeyEncByRecovery` + `recoverySalt` + `recoveryIv`, wrapping key
  `HKDF-SHA256(recovery-key bytes)` over a high-entropy, client-generated, shown-once **recovery key**
  (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`, ~125 bits).

ADR-0061 made the two copies **symmetric**: either credential, alone, unlocks the private key directly.
[[0065-secret-manager-regenerate-recovery-key]] then added a "regenerate the recovery key **with the
password**" flow — letting the weaker daily credential re-mint the root artifact in place.

In QA the CEO refined the model. Symmetry plus "the password can regenerate the recovery key" is the wrong
shape for a credential hierarchy:

- A **stolen password** is the common threat (it is typed daily, is lower-entropy, lives in a password
  manager / muscle memory). If the password can **rotate the recovery key** (ADR-0065), an attacker who
  steals the password can mint a fresh recovery key, **discard the old one, and lock the legitimate owner
  out of their own root** — the weaker credential overwrites the stronger.
- The recovery key is meant to be the **offline, high-entropy, shown-once DR artifact** — the thing you
  put in a safe. It should be the credential of *last resort* that can rescue a lost password, **not** a
  second daily door, and **not** something the daily door can silently replace.

The fix is a clean **asymmetric** hierarchy: the password is the mutable daily entry; the recovery key is
the immutable root that can only **reset** the password. The weaker credential must never be able to touch
the stronger one.

## Considered options

- **Keep the symmetric model + password-regenerates-recovery (ADR-0061 + ADR-0065 as-built).** *Rejected.*
  It lets a stolen password rotate the root and lock out the owner (the threat above). It also blurs the
  roles: two equal daily doors with the weaker able to overwrite the stronger is a credential hierarchy
  upside-down.

- **Asymmetric: password = daily entry (mutable), recovery key = root that only resets the password
  (CHOSEN).** The password is the single direct ENTRY credential and is freely **changeable** (re-wrap
  Copy A using the current password). The recovery key is **not** a direct entry path and is **not**
  regenerable with the password; its sole power is to **RESET** the password (re-wrap Copy A using the
  recovery key). The weaker credential can never replace the root. Fixed at bootstrap (rotation deferred).

- **Make the recovery key regenerable, but only with the recovery key itself.** *Rejected for now
  (deferred).* It is coherent (the root rotates itself), but it is not the #452 need and adds a fourth
  keypair write path. Recovery-key rotation is recorded as a deferred follow-up; this ADR fixes the
  recovery key at bootstrap.

**Chosen: asymmetric password-entry / recovery-root.** One endpoint serves both **change** (current
password) and **reset** (recovery key) because the server cannot tell — and need not know — which credential
the client used to unlock; it only ever receives the new Copy A blob.

## Decision

### 1. The two credentials, asymmetric

| | **Password (Copy A)** | **Recovery key (Copy B)** |
| --- | --- | --- |
| Role | Daily **ENTRY** credential | **ROOT** of trust / DR artifact |
| Entropy / handling | User-chosen; typed often; in a password manager | High-entropy, offline, shown **once** |
| Direct unlock (ENTER) | **Yes** — the only direct entry path | **No** — not a direct entry path |
| Mutable? | **Yes** — user may change it | **No** — fixed at bootstrap (rotation deferred) |
| Can reset the password? | n/a (it *is* the password) | **Yes** — its sole power |
| Can rotate the recovery key? | **No** (ADR-0065 reverted) | n/a |

The decisive rule: **the weaker credential (password) can never replace the root (recovery key); the root
resets the password, the password cannot touch the root.**

### 2. Operations

- **(a) ENTER — password only.** A session unlocks the private key with the **password** (Argon2id →
  unwrap Copy A). The previously symmetric "unlock directly with the recovery key" UI path is **removed**
  in the frontend wave — the recovery key is no longer a daily door, only a reset credential. (Copy B
  stays on the row, unchanged, as the reset input; nothing about its storage changes.)

- **(b) CHANGE password — requires the current password.** The client unlocks the private key with the
  **current password** in the browser, derives a fresh `Argon2id(new password)` wrapping key, and
  re-wraps the private key, producing a new Copy A (`privateKeyEncByPassphrase` + `passphraseSalt` +
  `passphraseIv` + `kdfParams`). It posts **only** the new Copy A blob.

- **(c) RESET password — requires the recovery key.** Same shape from the server's view: the client
  unlocks the private key with the **recovery key** (HKDF → unwrap Copy B) in the browser, then re-wraps
  it under `Argon2id(new password)` and posts the new Copy A blob. **After a reset the session
  auto-unlocks** — the client already holds the plaintext private key it just unlocked, so no second
  password prompt is needed.

- **(d) The recovery key is NOT regenerable with the password.** The ADR-0065 flow is **reverted**: there
  is no endpoint to re-mint Copy B using the password. The recovery key is **fixed at bootstrap**;
  recovery-key rotation is **deferred** (a future ADR, see §Follow-ups). The bootstrap/peer-reset paths
  that *do* mint a fresh recovery key (`POST /keypair`, `PUT /keypair/me`) are unchanged.

**One endpoint for (b) and (c).** Both change and reset produce **the same artifact** — a new Copy A blob —
and the server **cannot and need not know** which credential the client used to unlock (zero-knowledge: it
never sees the password or the recovery key). So a single self-only write serves both:

```
POST /secret-manager/keypair/password     (self-only; principal from the auth context)

request body (all base64 unless noted; same shape discipline as the existing keypair DTOs):
{
  privateKeyEncByPassphrase: string   // NEW Copy-A wrapped private-key blob (ciphertext‖tag)
  passphraseSalt:            string   // NEW Argon2id salt for the password wrap
  passphraseIv:              string   // NEW AEAD IV for the password wrap
  kdfParams:                 object   // the Argon2id parameters stamped on the new wrap
}

server behaviour:
- requires an EXISTING live UserKeypair for the caller (404 if none — this is NOT bootstrap)
- updates ONLY privateKeyEncByPassphrase / passphraseSalt / passphraseIv / kdfParams; bumps updatedAt
- leaves publicKey, privateKeyEncByRecovery, recoverySalt, recoveryIv UNTOUCHED (Copy B keeps working)
- audits a PASSWORD_CHANGED event (metadata only — who/when; never a credential or blob)
- HumanOnlyGuard + the same `secret:read` capability gate as the other keypair routes
- self-only: there is NO `:userId` admin variant
```

Because **only Copy A** is rewritten, the **public key**, the per-vault **DEKs**, and **every**
[[vault-membership]] are untouched — there is no DEK re-wrap and no membership churn (identical surgical
property to ADR-0065's recovery re-mint, now applied to the password wrap instead).

### 3. AuthZ — self-only

A user changes/resets their **OWN** password. There is **no admin-acting-on-another-user variant** — an
admin cannot re-wrap Copy A for someone else because it requires unlocking that user's private key (with
their password or recovery key), which the admin and the server cannot do. This is INV-8's exact boundary
— ADMIN omnipotence is over **authorization/visibility**, **never** cryptographic plaintext (INV-10). The
endpoint derives the target keypair from the authenticated principal only.

## Security & invariants

- **INV-10 preserved end to end.** The `keypair/password` endpoint stores **ciphertext only** — it
  receives the new `privateKeyEncByPassphrase`/`passphraseSalt`/`passphraseIv`/`kdfParams`, writes them,
  and audits metadata. It **never** sees the private key, the password (old or new), or the recovery key.
  There is **no** server-side `reveal()` and **no** env master key — identical custody to bootstrap/reset.
  The INV-10 architectural guard test pins the new route (no cipher import, no `*_KEY` env, returns the
  wire shape).

- **The recovery key becomes the master / takeover credential.** Whoever holds the recovery key can reset
  the password and thereby take over the vault. This is **inherent to "the recovery key resets the
  password"** — a reset credential is, by definition, a takeover credential. It is **mitigated by the
  recovery key's properties**: it is offline, high-entropy (~125 bits), and shown **once** — so an
  attacker must physically obtain the off-host artifact, which is a far higher bar than stealing a typed
  password. The trade made here is deliberate: the *common* threat (a stolen password) can no longer rotate
  the root or lock the owner out (the ADR-0065 hazard); the *rarer* threat (a stolen recovery key) was
  already a full compromise under the old model too (it could unlock directly).

- **Server cannot validate the new blob.** As with every keypair write, the server **cannot verify** the
  posted Copy A actually decrypts to the user's private key — correctness is the **client's**
  responsibility (the existing trust model). A malformed blob is self-inflicted (the user's own future
  password unlock fails); it cannot harm other users or leak plaintext. Base64/length validation carries
  over from the existing keypair DTOs.

- **🚩 Crypto-critical surface — `lazyit-sentinel` at review.** Confirm: self-only (no `:userId` variant);
  the endpoint **requires a live keypair** (cannot be used as a bootstrap); it writes **only** the four
  Copy-A columns (never `publicKey` or any Copy-B column); the INV-10 guard covers the route. The dormant
  enum note below is intentional, not a bug.

### Dormant audit enum value (`RECOVERY_KEY_REGENERATED`)

ADR-0065 added `RECOVERY_KEY_REGENERATED` to the `SecretAuditAction` Postgres enum (migration
`20260615120000_recovery_key_regenerated`, already applied). Reverting ADR-0065 removes the *code* that
writes it, but the **enum value is left orphaned/dormant**: dropping a value from a Postgres enum requires
recreating the type (a risky, dependency-heavy `ALTER`), which is **not worth it** for an unused, harmless
value. No existing row uses it (the ADR-0065 frontend never shipped), so it simply lingers. The new
`PASSWORD_CHANGED` value is added additively beside it.

## Consequences

- **Positive:**
  - **A correct credential hierarchy:** the daily password can never overwrite or lock out the root; the
    root resets the password. A stolen password can no longer rotate the recovery key (the ADR-0065
    hazard is gone).
  - **Password is now changeable** — a first-class operation the model previously lacked (you could only
    reset the whole keypair). Re-wrapping Copy A is **non-destructive and churn-free** (keypair, DEKs, all
    memberships untouched).
  - **One endpoint, two operations** — change (current password) and reset (recovery key) collapse into a
    single self-only ciphertext write because the server cannot tell which credential unlocked the client.
    Minimal surface, INV-10-clean.
  - **Cleaner mental model** for users and the help surface: *password = your daily door (changeable);
    recovery key = the master key in the safe that resets your door.*
- **Negative / trade-offs (accepted):**
  - **The recovery key is a takeover credential** — whoever has it can reset the password and seize the
    vault. Inherent to "recovery resets password"; mitigated by offline + high-entropy + shown-once.
  - **The recovery key is not user-regenerable** — a user who loses it (but keeps the password) can no
    longer mint a new one in place (the ADR-0065 power is reverted). They are one password-loss from
    peer-reset (or, single-member, permanent loss). Recovery-key **rotation** is deferred (Follow-ups);
    until then, losing the recovery key means falling back to a full **reset/peer-reset** of the keypair
    if the password is ever lost.
  - **A dormant enum value** (`RECOVERY_KEY_REGENERATED`) lingers in the DB — harmless, documented above.
- **Follow-ups:**
  - **Frontend wave:** remove the direct-unlock-with-recovery-key entry UI (recovery key is reset-only);
    wire **change password** (current password) and **reset password** (recovery key) onto the one
    `POST /keypair/password` endpoint, auto-unlocking the session after a reset.
  - **Recovery-key rotation (deferred):** a future ADR may let the recovery key rotate **itself** (root
    rotates root) — explicitly NOT the password rotating it.
  - **Docs sync:** the [[user-keypair]] entity note's credential-lifecycle section
    (bootstrap → enter → change-password → reset-password → peer-reset) and the [[03-decisions/_MOC|ADR index]]
    rows for [[0061-secret-manager-zero-knowledge]] / [[0065-secret-manager-regenerate-recovery-key]]
    should be updated to the asymmetric model (out of this backend wave's lane — flagged for the next pass).
  - **Manual / help surface** ([[0062-in-app-help-manual-surface]]) — explain change-vs-reset and that the
    recovery key resets the password but is not a daily door.

**Related:** [[0061-secret-manager-zero-knowledge]] (amended) · [[0065-secret-manager-regenerate-recovery-key]]
(superseded) · [[secret-manager-crypto-design]] · [[0048-service-accounts]] · [[0046-roles-permissions-v2]] ·
[[0031-logging-strategy]] · [[user-keypair]] · [[vault-membership]] · [[secret-vault]] · [[user]] ·
[[INVARIANTS]] (INV-8 / INV-10)
