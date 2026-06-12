---
title: "Secret Manager — crypto design note (build-time primitives)"
tags: [development, security, secrets, crypto, secret-manager, knowledge-base]
status: accepted
created: 2026-06-12
updated: 2026-06-12
---

# Secret Manager — crypto design note (build-time primitives)

> **This is a BUILD design note, not an ADR.** The decision of record is
> [[0061-secret-manager-zero-knowledge|ADR-0061]] — it stays authoritative; this note does **not**
> change it, renumber it, or introduce a new decision. It **pins the concrete primitives** (libraries,
> parameters, encodings, byte layouts, where each operation runs) so the implementation slice (#366)
> can build `@lazyit/shared` crypto utils + the frontend flows **without re-deriving** anything. Where
> this note and the ADR appear to differ, the ADR wins and this note is wrong — fix it.
>
> **Scope:** documentation only. No code, schema, migration, endpoint, or UI is produced here. Library
> versions and APIs in this note were grounded against current docs (Context7, June 2026) and pinned
> below.

This is lazyit's **first** Argon2id / asymmetric / envelope crypto path — the riskiest code in the
repo. It is the deliberate **crypto-model inverse** of the engine's server-decryptable
[[workflow-secret]] (`apps/api/src/workflow-engine/secrets/secret.service.ts`): that store *must* be
server-readable (a connector authenticates at run time, so `reveal()` and `WORKFLOW_SECRET_KEY` exist
by design); the Secret Manager *must not* be — **the server can never decrypt a stored human secret
value** (INV-10). Everything below is built to honour that one line.

---

## 0. Library & parameter decisions (the pins)

All three libraries are **MIT-licensed, audited or maintained pure-JS/WASM** with no native bindings
(works in Bun tooling, NestJS Node, and a Next 16 / React 19 browser without `node:crypto`):

| Concern | Library (pinned) | Why it wins | Where it runs |
| --- | --- | --- | --- |
| **KDF — Argon2id** | **`hash-wasm@4.12.0`** | Hand-tuned WASM Argon2id, ~10× faster than asm.js; tiny; lazy-loads its `.wasm`; `outputType: 'binary'` returns the **raw 32-byte derived key** (not a PHC string) — exactly what we need to *derive a wrapping key*, not *verify a password*. | **Browser only** (and tests). |
| **Asymmetric (keypair + ECDH)** | **`@noble/curves@2.2.0`** (`x25519`) | Audited, minimal, zero-dep X25519. `x25519.keygen()` / `x25519.getSharedSecret()`. 32-byte keys → tiny wrapped blobs. | **Browser only** (and tests). |
| **AEAD — AES-256-GCM** | **`@noble/ciphers@2.2.0`** (`gcm`) | Audited AES-GCM that produces the **same envelope shape** as the `node:crypto` `WorkflowSecret` path (ciphertext ‖ 16-byte tag, explicit 12-byte nonce), so client and server agree byte-for-byte on the `SecretItem` columns. | **Browser only** (and tests). |
| **HKDF (shared-secret → AES key)** | **`@noble/hashes@2.2.0`** (`hkdf` + `sha256`) | Audited HKDF-SHA-256 to expand the raw X25519 shared secret into a clean 32-byte AES key (never use the raw DH output directly as a key). | **Browser only** (and tests). |

**Argon2id parameters (pinned — see §1 for the threat justification):**

| Parameter | Value | hash-wasm field |
| --- | --- | --- |
| Algorithm | **Argon2id** | `argon2id(...)` |
| Memory | **65536 KiB (64 MiB)** | `memorySize: 65536` |
| Iterations (time cost) | **3** | `iterations: 3` |
| Parallelism (lanes) | **1** | `parallelism: 1` |
| Salt | **16 bytes**, CSPRNG, unique per derivation, stored in clear | `salt: Uint8Array(16)` |
| Output | **32 bytes (256-bit)**, raw | `hashLength: 32`, `outputType: 'binary'` |

These match the **OWASP Argon2id "m=64 MiB, t=3, p=1" baseline** and the current PHC/RFC 9106 guidance
for an interactive, memory-constrained client. They are **recorded as config constants in
`@lazyit/shared`** (so client and any future re-derivation agree) and **stamped into the wrapped-key
blob header** (§4) so a future parameter bump is detectable and recoverable.

---

## 1. KDF — Argon2id (deriving the private-key wrapping key)

### What it derives, and what it does NOT

Argon2id here is **not** a password *verifier* (that is the `WorkflowSecret`/SA-token world). The two
existing stores use the *right* tool for *their* job — and Argon2id would be wrong for them:

- The **service-account token** ([[0048-service-accounts]]) is a 256-bit random secret, SHA-256-hashed.
  A high-entropy random secret does **not** need a slow KDF (ADR-0048 says so explicitly). Verify-only.
- Here the input is a **human-chosen vault passphrase** (low entropy, guessable), and the output is a
  **wrapping key** that encrypts the user's private key. A guessable passphrase is the weak link
  (Threat model, "weak vault passphrase"), so we need a **memory-hard KDF** to make offline brute-force
  of a stolen `privateKeyEncByPassphrase` blob ruinously expensive.

```
wrappingKey = Argon2id(
  password   = vaultPassphrase (UTF-8 bytes, never persisted, never logged),
  salt       = passphraseSalt  (16 random bytes, stored in clear on UserKeypair),
  memorySize = 65536,  // 64 MiB
  iterations = 3,
  parallelism= 1,
  hashLength = 32,     // 256-bit AES key
  outputType = 'binary'
)  →  Uint8Array(32)
```

`wrappingKey` is then used as the **AES-256-GCM key** that encrypts the X25519 private key (§4). It is
**ephemeral in the browser**, zeroed/dropped after use, and **never** sent to the server.

### Browser execution story — WASM, not WebCrypto

**WebCrypto (`crypto.subtle`) does NOT implement Argon2id.** SubtleCrypto's only password-KDF is
**PBKDF2**, which is *not* memory-hard and is GPU/ASIC-cheap — unacceptable for a low-entropy passphrase
guarding a private key. So Argon2id must come from a library:

- **Chosen: `hash-wasm@4.12.0`** — hand-tuned WebAssembly. It runs in any modern browser (Next 16 /
  React 19 client component), in Bun, and in Node. WASM gives near-native Argon2id throughput, which
  matters because 64 MiB × t=3 must complete in **well under ~1 s on a typical laptop** for an unlock
  prompt to feel instant. hash-wasm lazy-loads its `.wasm` payload and exposes `outputType: 'binary'`
  to return raw key bytes.
- **Rejected: `argon2-browser@1.18.0`** — last published 2021, effectively unmaintained, ships an
  asm.js fallback that is ~10× slower, and has known bundler-pain loading its `.wasm` under modern
  toolchains. No reason to take that risk for a new build.
- **Rejected: `libsodium-wrappers`** — a fine Argon2id, but pulls in a large all-of-libsodium WASM blob
  and a second, overlapping crypto surface alongside noble. We already need noble for X25519 + AES-GCM;
  adding libsodium duplicates primitives and bloats the client bundle. One curve/cipher vocabulary
  (noble) + one KDF (hash-wasm) is the smaller, more auditable surface.

> **Next 16 / React 19 note (for the build agent, not decided here):** Argon2id and all unwrap/decrypt
> code MUST run in a **Client Component** (`"use client"`) — it touches `window.crypto`, the WASM
> instance, and the passphrase, none of which may exist server-side. The `.wasm` asset loads
> client-side; verify it is **not** pulled into a Server Component / RSC graph and that the bundler
> emits the wasm correctly (a Phase-2 wiring detail, flagged as an open question, §9).

### Threat justification of the parameters (5–20-person self-hosted team)

- **64 MiB / t=3 / p=1** is the OWASP-recommended interactive baseline and RFC 9106's "second
  recommended" (memory-constrained) profile. It is sized so the **defender** pays ~0.3–0.8 s per unlock
  on commodity hardware, while an **attacker** brute-forcing a stolen blob pays 64 MiB *per guess* —
  collapsing GPU/ASIC parallelism (the whole point of memory-hardness).
- **p=1** because the unlock is single-user, single-shot in a browser tab; parallel lanes buy little on
  one core and complicate the WASM path. Memory hardness (not lane count) is the lever here.
- **Why not higher (e.g. 256 MiB)?** This is a **client-side** KDF on whatever laptop a team member
  uses; 64 MiB is the sweet spot that stays under a second on low-end hardware while remaining painful
  at scale. The passphrase policy (length/strength nudge in the UI) is the complementary control — the
  ADR Threat model already names "a weak vault passphrase" as accepted residual risk.
- **Recovery key needs no Argon2id** (§4): it is **high-entropy random** (≥128 bits), so a fast KDF is
  sufficient for it — the same reasoning ADR-0048 used for the SA token. Argon2id is reserved for the
  **low-entropy** input (the passphrase). This asymmetry is deliberate.

---

## 2. Per-user keypair — X25519, and how a DEK is wrapped/unwrapped

### Algorithm: X25519 (ECDH), not RSA-OAEP, not P-256

Each [[user]] has **one [[user-keypair]]** (1:1 with the `uuid` User):

| | X25519 (**chosen**) | RSA-OAEP | ECDH P-256 |
| --- | --- | --- | --- |
| Public key size | **32 bytes** | 256–512 bytes | 65 bytes |
| Private key size | **32 bytes** | ~1.2 KB | 32 bytes |
| WebCrypto native | No | Yes | Yes |
| noble support | **Yes** (`@noble/curves`) | n/a | Yes |
| Misuse-resistance | **High** (no padding oracle, no curve-param footguns) | RSA-OAEP padding is a classic footgun | Point-validation care needed |

**Chosen: X25519.** Tiny keys → tiny `publicKey`, `privateKeyEncByPassphrase`, and wrapped-DEK blobs
(all base64 text columns). No padding oracle. Designed for exactly this — **wrap a symmetric key to a
recipient's public key** via ECDH. WebCrypto lacks X25519 broadly enough that we don't rely on it;
`@noble/curves@2.2.0` is audited and runs everywhere we need.

> **WebCrypto P-256 was considered** because `crypto.subtle` supports ECDH P-256 natively (no library).
> Rejected to keep **one** asymmetric vocabulary (noble X25519) shared by client *and* any test/Node
> path, avoiding two key encodings and the larger P-256 footgun surface. Revisit only if bundle size of
> noble-curves becomes a real problem (it is small; this is unlikely).

### Encoding (pinned)

- `publicKey`: **32 raw bytes → base64** (stored in clear; it is public).
- `privateKey`: **32 raw bytes**, **never stored raw** — only the two wrapped copies exist (§4).
- All at-rest blobs are **base64 text columns** (same portability choice as `WorkflowSecret`'s
  `ciphertext`/`iv`/`authTag`).

### Wrapping a DEK to a public key (the "grant" primitive)

This is the heart of [[vault-membership]] and the ADR §4 "no grant-what-you-can't-read" rule.
**ECIES-style** over X25519, all client-side:

**Wrap (grant member M into vault V — performed by an existing member who can already unwrap V's DEK):**

```
1. ephKeypair        = x25519.keygen()                       // fresh ephemeral, per wrap
2. shared            = x25519.getSharedSecret(ephKeypair.secretKey, M.publicKey)
3. kek               = hkdf(sha256, shared, salt=Ø, info="lazyit/vault-dek-wrap/v1", 32)
4. nonce             = randomBytes(12)
5. wrappedDEK        = gcm(kek, nonce).encrypt(DEK)           // DEK = 32 raw bytes
6. store on the new VaultMembership row:
      ephemeralPublicKey  (base64, 32B)
      wrapNonce           (base64, 12B)
      wrappedDek          (base64, ciphertext ‖ 16B tag)
      wrapVersion         (int; see §3 keyVersion semantics)
```

**Unwrap (member M reads vault V):**

```
1. privKeyM          = unlock M's private key (§4: passphrase or recovery key)
2. shared            = x25519.getSharedSecret(privKeyM, row.ephemeralPublicKey)
3. kek               = hkdf(sha256, shared, salt=Ø, info="lazyit/vault-dek-wrap/v1", 32)
4. DEK               = gcm(kek, row.wrapNonce).decrypt(row.wrappedDek)   // 32 raw bytes
```

- The **ephemeral keypair is fresh per wrap** → forward-secrecy of the wrap operation and a unique
  `kek`/`nonce` per `VaultMembership` row. The server stores `ephemeralPublicKey` + `wrapNonce` +
  `wrappedDek` in clear; none of it discloses the DEK without M's private key.
- **HKDF is mandatory** — never feed the raw X25519 shared secret directly to AES-GCM. The `info` string
  domain-separates this wrap from any other ECDH use.
- **You can only do step 1 of "wrap" if you could do "unwrap" on your own membership** — i.e. you must
  already hold the DEK. That is the **crypto enforcement** of INV-9's no-escalation twin: the server
  cannot mint a wrapped DEK, and an ADMIN never wrapped into the vault cannot conjure one.

---

## 3. Vault DEK — generation and the SecretItem AES-256-GCM envelope

### DEK generation

```
DEK = crypto.getRandomValues(new Uint8Array(32))   // 256-bit, CSPRNG, client-side at vault creation
```

The DEK is **generated in the browser by the vault creator**, is **never stored in clear**, and exists
on the server only as per-member **wrapped** copies on [[vault-membership]] rows (§2). The creator's own
membership is the first wrapped copy.

### SecretItem envelope — reuse the WorkflowSecret column shape EXACTLY

A [[secret-item]] stores **only the ciphertext** of its value, under the vault DEK, in columns that
**mirror [[workflow-secret]] byte-for-byte** (`apps/api/src/.../secret.service.ts` and the
`WorkflowSecret` Prisma model `ciphertext`/`iv`/`authTag`/`keyVersion`):

| Column | Type | Content |
| --- | --- | --- |
| `ciphertext` | `String` (base64) | AES-256-GCM ciphertext of the UTF-8 value |
| `iv` | `String` (base64) | **96-bit (12-byte) random IV/nonce, fresh per value** |
| `authTag` | `String` (base64) | 128-bit (16-byte) GCM auth tag |
| `keyVersion` | `Int` (default 1) | **which DEK version produced this envelope** (see below) |

**Encrypt (client-side, member who holds the unwrapped DEK):**

```
iv         = randomBytes(12)                       // 96-bit, GCM-recommended, fresh per value
sealed     = gcm(DEK, iv).encrypt(utf8(value))     // sealed = ciphertext ‖ 16-byte tag
ciphertext = base64( sealed[ .. -16] )
authTag    = base64( sealed[-16 .. ] )
keyVersion = vault.currentDekVersion               // 1 in v1
```

> **noble vs node:crypto tag layout (build note):** `@noble/ciphers` `gcm(...).encrypt()` returns
> `ciphertext ‖ tag` concatenated; the `node:crypto` path in `secret.service.ts` exposes `authTag`
> separately via `cipher.getAuthTag()`. The **stored columns are identical** (`ciphertext` excludes the
> tag, `authTag` holds the trailing 16 bytes) — the `@lazyit/shared` util MUST split the noble output
> into `ciphertext` + `authTag` on write and re-concatenate on read, so the two stores are
> wire-compatible and a reviewer sees one envelope shape. This split is the single most important
> "don't get it subtly wrong" detail for the build agent.

**Decrypt (client-side):** re-concatenate `base64⁻¹(ciphertext) ‖ base64⁻¹(authTag)`, call
`gcm(DEK, base64⁻¹(iv)).decrypt(...)`, UTF-8 the result. GCM verifies the tag; any tamper throws — and
the thrown error carries **no plaintext, no key material** (mirroring `reveal()`'s catch, §8).

### What `keyVersion` means here (vs WorkflowSecret)

- In `WorkflowSecret`, `keyVersion` tracks the **server's env master key** version (rotate
  `WORKFLOW_SECRET_KEY` without re-reading plaintext).
- **Here there is no env master key.** `keyVersion` tracks the **vault DEK version**. v1 ships a single
  DEK per vault (`keyVersion = 1`). It exists so the **deferred hard-revoke / DEK-rotation** (ADR §5,
  Phase 2) can re-encrypt items under a new DEK and stamp `keyVersion = 2`, letting a reader pick the
  right (wrapped) DEK without re-deriving plaintext. **v1 writes 1 and never rotates**; the column is
  the forward-compat seam, identical in spirit to the precedent.

---

## 4. Private key at rest — two wrapped copies (passphrase + recovery key)

The [[user-keypair]] `privateKey` (32 raw X25519 bytes) is persisted **only** as **two independent
AES-256-GCM-wrapped copies**, so loss of *one* unlock path is survivable:

### Copy A — under `Argon2id(vault passphrase)`

```
passphraseSalt = randomBytes(16)                           // stored in clear on UserKeypair
wrappingKeyA   = Argon2id(vaultPassphrase, passphraseSalt, m=65536,t=3,p=1,len=32)  // §1
ivA            = randomBytes(12)
sealedA        = gcm(wrappingKeyA, ivA).encrypt(privateKey)
→ store: privateKeyEncByPassphrase (base64 sealedA), passphraseSalt (base64),
         passphraseIv (base64), kdfParams { m,t,p, alg:"argon2id", v:1 }   // params recorded for re-derivation
```

### Copy B — under the recovery key

```
recoveryKey    = generateRecoveryKey()                     // §4.1 — high-entropy, shown ONCE
recoverySalt   = randomBytes(16)
wrappingKeyB   = HKDF(sha256, recoveryKeyBytes, salt=recoverySalt, info="lazyit/recovery-wrap/v1", 32)
ivB            = randomBytes(12)
sealedB        = gcm(wrappingKeyB, ivB).encrypt(privateKey)
→ store: privateKeyEncByRecovery (base64 sealedB), recoverySalt (base64), recoveryIv (base64)
```

**Why HKDF (fast) for the recovery key but Argon2id (slow) for the passphrase:** the recovery key is
**generated random ≥128-bit entropy** — brute-forcing it is already infeasible, so a memory-hard KDF
buys nothing and would only slow the legitimate recovery. The passphrase is **human-chosen / low
entropy**, so it needs Argon2id. This mirrors ADR-0048's "high-entropy secret → fast hash; low-entropy
password → slow hash" reasoning, applied to wrapping instead of verifying.

> **Unlock** = derive the relevant wrapping key (Argon2id-from-passphrase **or** HKDF-from-recovery-key),
> AES-GCM-decrypt the matching blob → recover the 32-byte `privateKey` **in browser memory only**. The
> server never sees a passphrase, a recovery key, a wrapping key, or an unwrapped private key.

### 4.1 Recovery-key format, entropy, and shown-once handling

- **Format (pinned):** **`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`** — 5 groups of 5 characters, hyphen-separated
  (matches [[user-keypair]] and ADR §3). The shared validator regex lives in `@lazyit/shared`
  ([[shared-package]]), reused by client UI and (for *format* only) any server-side shape check —
  **the server validates shape, never value**.
- **Alphabet:** a 32-symbol **Crockford-base32** set (`0-9A-Z` minus `I L O U` to avoid ambiguity).
  25 symbols × log₂(32) = **125 bits of entropy** — comfortably ≥128-bit-class, no slow KDF needed (§4).
- **Derivation of bytes:** the 25 base32 symbols decode to the recovery-key byte string fed to HKDF
  (the hyphens are display-only and stripped before decode). Generated client-side via
  `crypto.getRandomValues`.
- **Shown once (the [[0048-service-accounts]] precedent):** generated **client-side**, **displayed
  exactly once** at keypair creation (and on any passphrase reset / peer-reset that re-mints it),
  **never persisted in clear, never logged** (§8, [[0031-logging-strategy]]). The server stores only
  `privateKeyEncByRecovery` + `recoverySalt` + `recoveryIv` — never the recovery key itself. Losing it
  means it cannot be re-shown — only re-minted (which requires already being able to unlock, i.e. via
  the passphrase or a peer-reset). It is the user's **personal, off-host DR artifact**; the operator
  cannot back it up for them ([[backups]], §8).

---

## 5. Wire shapes — what the server stores/serves vs what NEVER touches it

This table **is** ADR §9 made concrete at the byte level. Everything in the left column is
server-visible at-rest/in-transit metadata or ciphertext; everything in the right column exists **only
transiently in plaintext in the browser** and is **structurally absent** from the server.

| Entity | Server STORES / SERVES (left of the §9 line) | NEVER touches the server (right of the §9 line) |
| --- | --- | --- |
| **UserKeypair** | `publicKey` (base64, **clear**); `privateKeyEncByPassphrase`, `passphraseSalt`, `passphraseIv`, `kdfParams`; `privateKeyEncByRecovery`, `recoverySalt`, `recoveryIv` | the **unwrapped private key**; the **vault passphrase**; the **recovery key**; the Argon2id/HKDF wrapping keys |
| **SecretVault** | `name`, member list (metadata) | the **DEK** (clear) |
| **VaultMembership** | `ephemeralPublicKey`, `wrapNonce`, `wrappedDek` (base64), `wrapVersion` | the **unwrapped DEK** |
| **SecretItem** | `label`/`handle` (metadata, clear); `ciphertext`, `iv`, `authTag`, `keyVersion` (base64/int) | the **plaintext value** |

**Wire/read-shape rules (mirroring `WorkflowSecret`'s write-only discipline):**

- **Vault passphrase, recovery key, unwrapped private key, unwrapped DEK, plaintext value** → **never**
  appear in any request body, response body, query param, URL, header, or log. Ever.
- A normal API **read shape** returns metadata + the **at-rest blobs the member's browser needs to
  decrypt** (e.g. fetching a `SecretItem` returns `ciphertext`/`iv`/`authTag`/`keyVersion`; fetching
  your `VaultMembership` returns `ephemeralPublicKey`/`wrapNonce`/`wrappedDek`). These are **ciphertext
  + public material**, never plaintext — handing them to the client is safe because only the client can
  unwrap. Contrast `WorkflowSecret`, whose read shape (`WorkflowSecretDescriptor`) **drops the envelope
  entirely** because the *server* decrypts it; here the *client* decrypts, so the client legitimately
  receives the blobs.
- The server's role is **ciphertext custodian + authorization fence** (§6): it decides *which rows you
  may fetch* (RBAC + membership), and is **structurally incapable** of producing any right-column value.

---

## 6. Where each operation runs — the full client-side chain, no server reveal

**Every** confidentiality-relevant operation runs in the **browser** (a Next 16 `"use client"`
component); the server only stores/serves blobs and enforces authorization. The end-to-end **read** is
exactly the ADR §3 chain:

```
[CLIENT]  unlock private key                                    (§4)
            wrappingKey = Argon2id(passphrase)  OR  HKDF(recoveryKey)
            privateKey  = AES-GCM-decrypt(privateKeyEncBy…)
[CLIENT]  unwrap the vault DEK from your VaultMembership row     (§2)
            shared = x25519.getSharedSecret(privateKey, row.ephemeralPublicKey)
            DEK    = AES-GCM-decrypt(row.wrappedDek, hkdf(shared))
[CLIENT]  decrypt the SecretItem ciphertext with the DEK        (§3)
            value  = AES-GCM-decrypt(item.ciphertext‖item.authTag, item.iv, DEK)
```

**Confirmed inversions of `secret.service.ts` (INV-10):**

- **NO server-side `reveal()` / `revealById()`.** There is no server method that returns a plaintext
  secret value, and the build MUST NOT add one. (`WorkflowSecret` has `reveal()` *by design*; the
  Secret Manager's defining property is its absence.)
- **NO env master key over values.** There is **no** `SECRET_MANAGER_KEY` analogue of
  `WORKFLOW_SECRET_KEY`. The server holds no key that decrypts any value, DEK, or private key. A
  compromised host / leaked `.env` yields **nothing decryptable**.
- **Server-side crypto is limited to** storing/serving blobs and enforcing authorization (RBAC
  `secret:read`/`secret:manage` + membership existence, ADR §7). DEK / keypair / recovery-key are all
  minted **client-side**, so the server never needs — and never gets — a key that decrypts a value.
  **Decryption capability is never enforced server-side; it cannot be.**

---

## 7. KB masked-chip touchpoint (`{{ lazyit_secret.HANDLE }}`)

The crypto touchpoint of ADR §8 (the render plugin itself is a later slice — only the **crypto
contract** is pinned here):

- The article markdown stores the token **`{{ lazyit_secret.HANDLE }}`** **verbatim** (write-raw,
  [[0029-untrusted-content-sanitization]]) — `HANDLE` is the secret's **server-visible handle**, never
  its value. The token is **inert text**; it can never be a stored-plaintext or stored-XSS sink.
- **Resolution is render-time and client-side**, reusing the §6 chain. At render the token becomes a
  **masked chip**. Revealing it requires the reader to **unlock their private key** (supply the vault
  passphrase) → unwrap the vault DEK → decrypt the referenced `SecretItem` — all in the browser. The
  **plaintext value never round-trips through the server**; the render layer fetches only the same
  ciphertext/wrapped-DEK blobs as §5 and decrypts in place.
- **Double gate (no escalation, end to end):** revealing a chip requires **both** access to the article
  (its [[folder]] ACL, INV-9) **AND** crypto membership of the secret's vault (§2). A reader who can
  open the article but is not a vault member sees a **locked chip** they cannot reveal — embedding a
  secret in an article **never widens** who can decrypt it.
- **Autocomplete** may offer **handles** (server-visible metadata) but **never values**.

---

## 8. Never-log / disaster recovery

### Never-log (cite [[0031-logging-strategy]])

**Never log, never put in an error message, never include in a response body or audit row:**

- a secret **value** (plaintext);
- a **private key** — wrapped or unwrapped;
- a **DEK** — wrapped or unwrapped;
- a **vault passphrase**;
- a **recovery key**;
- any **Argon2id/HKDF-derived wrapping key**.

A **decrypt-failure error carries NO plaintext and NO key material** — it mirrors `secret.service.ts`'s
`reveal()` catch verbatim in spirit: *"authentication failed or wrong key"*, no payload in the message
(a GCM tag failure is indistinguishable from a wrong key, which is correct). **Audit rows record
metadata only** — *who* acted on *which* vault/item — never the value. ADR-0031's existing redaction
(`authorization`, `cookie`, `x-user-id`, bodies-not-logged) already covers the request surface; this
note adds the **payload classes above** as never-log even when they would otherwise be a logged field.

### Disaster recovery (ADR §10)

- The **recovery key is the user's PERSONAL, off-host, shown-once DR artifact** — the zero-knowledge
  analogue of `ZITADEL_MASTERKEY` / `WORKFLOW_SECRET_KEY` in [[backups]], except it is **per-user and
  never on the host**.
- **A DB + `.env` restore brings back CIPHERTEXT ONLY** — `ciphertext`/`iv`/`authTag`, public keys,
  wrapped DEK blobs, and the encrypted private-key blobs. It does **NOT** restore the ability to
  decrypt: that still requires a surviving member's **vault passphrase** (to Argon2id-unlock their
  private key) or their **off-host recovery key**. Unlike the workflow key, **the server cannot
  re-enter a value** it never held.
- **Loss model (no back door):** lose passphrase but keep recovery key → recoverable (unlock via
  recovery key, reset passphrase). Lose both but the vault has another member → **peer-reset** (set a
  new passphrase → new keypair; a peer re-wraps the DEK to your new public key, §2). Lose both on a
  **single-member** vault → **permanent, irrecoverable loss** (ADR §6 `[!danger]`). The mitigations are
  the shown-once recovery key (store it off-host) and **never leaving a vault that matters
  single-member** — the UI must nudge both.
- **[[backups]] follow-up (ADR §10):** add a zero-knowledge row to the DR inventory — *"Secret Manager
  values survive a DB restore as ciphertext; they are readable only by a surviving member's vault
  passphrase or off-host recovery key — the server cannot re-enter them, unlike the workflow key."*

---

## 9. Open questions / risks to ratify (CTO)

Decisions I had to make where the ADR left the build a choice, or risks worth a sign-off **before #366
backend/crypto coding begins**:

1. **Argon2id parameters — ratify `m=64 MiB, t=3, p=1, 16-byte salt, 32-byte out`.** OWASP/RFC 9106
   interactive baseline, sized for a client-side unlock under ~1 s on commodity hardware. If you want a
   stronger default (e.g. 128/256 MiB) at the cost of slower unlocks on low-end laptops, say so now —
   the value is a `@lazyit/shared` constant and is stamped into `kdfParams`, so a later bump is
   *possible*, but it forces a passphrase-driven re-wrap of every affected private key, so it is far
   cheaper to pick the right number up front.
2. **X25519 over WebCrypto P-256 — ratify the single noble vocabulary.** I chose X25519
   (`@noble/curves`) for tiny keys, no padding/curve footguns, and one client+test crypto surface,
   rather than native WebCrypto ECDH-P256. Trade-off: we depend on noble rather than the browser's
   built-in. Confirm you're happy taking the (audited, MIT) dependency vs the native primitive.
3. **Recovery-key entropy/alphabet — ratify 125-bit Crockford-base32 (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`).**
   The ADR pins the *format*; I pinned the *alphabet* (32-symbol, ambiguous letters dropped) and
   *entropy* (~125 bits → fast HKDF wrap, no Argon2id). Confirm 125 bits is acceptable, or require a
   full 128 (e.g. a 6th group / longer groups), which changes the displayed format.
4. **Where do the crypto utils live — `@lazyit/shared` vs `apps/web`?** [[shared-package]] forbids
   framework code and app deps in `@lazyit/shared`, but explicitly allows **pure framework-agnostic
   utils**. `hash-wasm` / `@noble/*` are framework-agnostic and run in Bun/Node/browser, so the **pure
   crypto primitives + the recovery-key zod validator** fit `@lazyit/shared` cleanly (one definition,
   client+test share it). **But** the WASM-loading / `window.crypto` glue and the React unlock flows are
   **web-only** and must stay in `apps/web`. My recommendation: **pure crypto functions + envelope
   shapes + recovery-key validator in `@lazyit/shared`; WASM bootstrap + UI flows in `apps/web`.**
   Ratify this split so the build agent doesn't put a `window`/`.wasm` dependency into the shared leaf.
5. **Next 16 / React 19 WASM delivery (build risk, not a decision).** Argon2id MUST run in a Client
   Component and the `.wasm` must not leak into the RSC/server graph. This is a known-solvable bundler
   wiring detail but is the most likely place a naive build breaks (or accidentally ships crypto into a
   Server Component). Flagging it so #366 budgets a spike to validate the wasm loads client-side under
   the Next 16 toolchain before building flows on top.
6. **AAD on the AES-GCM envelopes — none in v1 (note, not blocker).** v1 binds nothing extra into the
   GCM additional-authenticated-data. We *could* bind e.g. `vaultId`/`itemId` as AAD to prevent
   ciphertext-shuffling between items, but it complicates the `WorkflowSecret`-identical column shape
   and the deferred DEK-rotation. I kept the envelope **identical to `WorkflowSecret`** (no AAD) for one
   reviewable shape; the integrity guarantee within a vault already comes from the GCM tag + the DEK
   being per-vault. Ratify "no AAD in v1" or ask me to add `vaultId|itemId` AAD (a small, contained
   change).
7. **No server-side `reveal()` is load-bearing — guard it in review/tests.** The single biggest
   regression risk is a future contributor adding a "convenience" server decrypt (the `WorkflowSecret`
   pattern is *right there* in the repo). Recommend #366 ships a test/lint guard asserting **no Secret
   Manager service exposes a plaintext-returning method and no `SECRET_MANAGER_KEY`-style env is read**,
   so INV-10 can't silently rot.

---

Related: [[0061-secret-manager-zero-knowledge]] · [[workflow-secret]] · [[secret-vault]] ·
[[secret-item]] · [[vault-membership]] · [[user-keypair]] · [[0048-service-accounts]] ·
[[0031-logging-strategy]] · [[0029-untrusted-content-sanitization]] · [[0046-roles-permissions-v2]] ·
[[shared-package]] · [[backups]] · [[code-conventions]] · [[INVARIANTS]] (INV-10)
</content>
