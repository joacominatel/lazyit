---
title: "ADR-0061: Secret Manager — zero-knowledge vaults beside the Knowledge Base"
tags: [adr, secrets, security, crypto, knowledge-base]
status: accepted
created: 2026-06-11
updated: 2026-06-11
deciders: [Joaquín Minatel]
---

# ADR-0061: Secret Manager — zero-knowledge vaults beside the Knowledge Base

## Status

accepted

> [!note] Decided — not yet integrated
> Ratified 2026-06-11 in a CTO/CEO design session; this ADR records the decision. **No code is built yet** — implementation is tracked by #366. Status is `accepted` (the decision stands), not `proposed`.

This is the **keystone ADR for the human Secret Manager** that sits beside the Knowledge Base v2
([[0059-kb-folders-links-and-import]] / [[0060-kb-folder-access-control]]). It is the deliberate
**crypto-model inverse** of the engine's server-decryptable credential store
([[0054-applications-workflow-engine]] §5, [[workflow-secret]]): where the workflow store *must* be
server-readable so a connector can authenticate at run time, the Secret Manager *must not* be —
the server can **never** decrypt a stored human secret value. It introduces lazyit's **first
asymmetric / password-derived / envelope** crypto path (none exists in-tree today) and binds the
**no-escalation** principle of [[0060-kb-folder-access-control]] (INV-9) into the crypto layer.

## Context

The CEO mandate: a **human secret manager** living next to the KB — somewhere an IT team keeps the
shared root password, the VPN PSK, the registrar login — where the **server can NEVER read the
values**, not even ADMIN, not even with a full DB + env dump in hand. The KB documents the *runbook*;
the Secret Manager holds the *credential the runbook needs*, and a KB article can **inline-reference**
one (decision §8) without the value ever transiting the server in clear.

lazyit already has **two** secret stores, and the new one is deliberately a **third, divergent** model:

- **The workflow engine's `WorkflowSecret`** ([[0054-applications-workflow-engine]] §5,
  `apps/api/src/workflow-engine/secrets/secret.service.ts`): **AES-256-GCM**, encrypted under a single
  server-held `WORKFLOW_SECRET_KEY` env master key. The server holds an `internal-only` `reveal()` /
  `revealById()` *by design* — a connector step must decrypt the Jira token in memory to authenticate
  at call time. **The server can read these.** That is correct for machine credentials, and it is
  recoverable-by-re-entry: lose the key and you re-type the connector tokens (`backups.md`).
- **The service-account token** ([[0048-service-accounts]],
  `apps/api/src/service-accounts/service-account-token.ts`): **SHA-256-hash-at-rest**, cleartext shown
  **once** on mint/rotate and never recoverable. Verified DB-first, constant-time (INV-SA-1). This is
  the **shown-once** precedent the recovery key and the unwrapped private key reuse.

Neither fits the mandate. A hash is one-way (you cannot *read back* a stored password — you can only
verify a guess), and the workflow store is, by construction, server-decryptable. There is **no
Argon2 / asymmetric / envelope crypto anywhere in the repo**. A human secret manager that the server
cannot read is a **new crypto path** — accepted deliberately (Consequences) against the
"opinionated / boring technology" stance, because the threat model is genuinely different:

- **The threat is the server itself.** For machine creds the threat is an external attacker; the server
  is trusted to hold the key. For a shared human password the threat surface *includes* a compromised
  host, a leaked DB dump, an over-privileged ADMIN, and a subpoena of the operator. The only honest
  answer is **zero-knowledge**: design so a server breach yields ciphertext, not plaintext.
- **"ADMIN sees everything" (INV-8) cannot extend to plaintext.** INV-8 makes ADMIN omnipotent over
  *authorization*. A zero-knowledge value has **no authorization gate to unlock** — there is no
  plaintext on the server for any capability to reveal. This is a sharp, deliberate exception, stated
  in §7 and INV-10.
- **Recovery becomes a user problem, not a server problem.** Because the server holds no key over the
  value, "I forgot my password" cannot be solved by the server re-reading the secret. It is solved by a
  **recovery key** (the user's personal, off-host DR artifact) or by a **peer re-wrap** (§6) — and a
  single-member vault that loses *both* is **permanently lost** (§6, `[!danger]`). That is inherent to
  zero-knowledge, not a defect.

The forces, then: a genuinely zero-knowledge value store; a crypto boundary small enough for a 5–20
person team to operate (no KMS, no HSM); reuse of the existing column shape and id/soft-delete/
partial-unique conventions; and a clean seam to the KB so an article can reference a secret without the
KB ever becoming a second, weaker secret store.

## Considered options

- **Reuse the server-decryptable workflow store (`WorkflowSecret`) for human secrets** — *rejected.*
  It is AES-256-GCM under a server-held env key with an `internal-only reveal()`: the server **can**
  read every value, which is the *exact* property the mandate forbids. A DB + `WORKFLOW_SECRET_KEY`
  dump yields every plaintext. Reusing it would silently downgrade a human password to a
  machine-readable credential and put a server-side `reveal()` one refactor away from the human
  values. The two stores must stay **physically and cryptographically separate** (§1).
- **One org-wide master key, escrowed by ADMINs** — *rejected.* A single key wrapping all vaults
  re-creates the workflow store's property (the holder of the key reads everything) and makes ADMIN —
  or anyone who compromises an ADMIN session / the escrow — a universal decryptor. It contradicts the
  mandate and INV-8's careful scoping (ADMIN is omnipotent over authorization, **never** plaintext).
  Per-user keypairs + per-vault DEKs (§2/§3) localize blast radius: compromising one member exposes
  only the vaults that member belongs to.
- **A shared password per vault (everyone in the vault types the same passphrase)** — *rejected.* No
  per-member revocation (you cannot un-tell a password), no per-member audit of *who could decrypt*,
  and rotation means re-distributing a passphrase out-of-band to N people. The per-user keypair makes
  membership a **row you can drop** (§5) and binds decryption capability to an individual identity.
- **Store the recovery key server-side (so the server can help when a user forgets)** — *rejected.*
  A server-held recovery key is a server-held master key by another name — it would let the server (or
  a DB dump) reconstruct a private key and therefore read values, breaking zero-knowledge. The recovery
  key is generated client-side, shown **once** (the [[0048-service-accounts]] shown-once precedent),
  and **never** persisted or logged in clear (§3, §10, INV-10).
- **Defer the whole thing and tell users "put it in a KB article"** — *rejected.* That turns the KB
  into an unencrypted secret store (the worst outcome) and is exactly what §8's masked-chip reference
  exists to prevent.

**Chosen:** a **third, zero-knowledge secret store** — folder-scoped **SecretVaults** holding a random
DEK, per-user **UserKeypair** envelopes, **VaultMembership** = a DEK wrapped to a member's public key,
with a recovery key and peer-reset for loss, two orthogonal authorization layers, and a masked KB
inline reference.

## Decision

### 1. A third, deliberately divergent secret store: zero-knowledge

The Secret Manager is a **new store**, physically separate from [[workflow-secret]] and the SA token,
with a **different entity set, crypto model, and threat model**:

| | [[workflow-secret]] (ADR-0054) | SA token (ADR-0048) | **Secret Manager (this ADR)** |
| --- | --- | --- | --- |
| Crypto | AES-256-GCM, **server-held** env key | SHA-256 hash (one-way) | **Envelope:** random per-vault DEK + per-user asymmetric keypair |
| Server can read the value? | **Yes — by design** (connector auth at run time) | No (hash; verify-only) | **No — never** (zero-knowledge) |
| Recovery on key loss | Re-enter the credentials | Re-mint (shown once) | **Recovery key** / peer re-wrap; else **permanent loss** |
| Threat model | External attacker; server trusted | External attacker; server trusted | **Server, DB dump, ADMIN, subpoena are in-scope** |

The divergence is **justified and bounded**: machine connector credentials **must** be
server-decryptable (a sandboxed step has to authenticate without a human present); human secrets
**must not** be (the threat surface includes the host). This is the **load-bearing inversion** of
ADR-0054 §5 — same project, opposite key-custody decision, on purpose. We **accept a second
encrypted-secret code path to audit** (Consequences) as the price of an honest zero-knowledge guarantee
— exactly the trade-off ADR-0054 already paid once ("a second encrypted secret store … accepted for
clean separation of duties"); here the separation is *cryptographic*, not just lifecycle.

### 2. Folder vaults are the crypto boundary

The unit of encryption is a **`SecretVault`** — a named vault that lives **alongside a KB folder**
([[folder]]) and is the **crypto boundary** for the secrets inside it. A vault has:

- a **server-visible NAME** and a **member list** (non-secret metadata — the server stores and shows
  these; they are *not* zero-knowledge, §9);
- a random **DEK** (data-encryption key, e.g. 256-bit) that encrypts every **`SecretItem`** value in
  the vault. **The DEK is NEVER stored in clear** — the only copies that exist are the per-member
  **wrapped** copies on `VaultMembership` rows (§4).

A **`SecretItem`** stores **only ciphertext** of its value, encrypted under the vault DEK, in columns
that **mirror [[workflow-secret]] exactly**: `ciphertext` / `iv` / `authTag` / `keyVersion` (base64
text, at-rest only, **never on a wire shape**, **never logged**). A non-secret `label` / `handle` is
server-visible (so the UI can list "Production DB root password" without the value, and §8 can
autocomplete it). The crucial difference from `WorkflowSecret`: the key that decrypts these columns is
the **DEK**, which the server never holds in clear — so there is **no server-side `reveal()`** (§3).

`SecretVault` and `SecretItem` are **mutable domain entities** → `cuid()`, `createdAt` + `updatedAt` +
`deletedAt` (soft delete) per [[0005-id-strategy]] / [[0006-soft-delete-and-auditing]]. Vault-name
uniqueness (and item-handle uniqueness within a vault) is a **live-only PARTIAL unique index
`WHERE "deletedAt" IS NULL`** ([[0041-soft-delete-reuse-and-restore]]), never a PSL `@unique`.

### 3. Per-user keypair envelope

Each [[user]] gets **one `UserKeypair`** (1:1 with the `uuid` User, [[0005-id-strategy]]):

- **`publicKey`** stored **in clear** (it is public — anyone may wrap a DEK to it; this is how granting
  works, §4).
- **`privateKey` encrypted under `Argon2id(vault passphrase)`** — a **per-user vault passphrase** (a
  dedicated Secret-Manager unlock secret the user sets on first use, captured **only** by the lazyit
  client on an unlock prompt) is run through **Argon2id** (a memory-hard KDF) to derive a wrapping key
  that encrypts the private key at rest. This is **not** the OIDC login password: authentication is
  delegated to the IdP and lazyit **never receives** the login credential
  ([[0016-auth-strategy-deferred]], [[0037-idp-choice-zitadel-byoi]], [[0039-authjs-v5-frontend-oidc]],
  [[0043-zitadel-source-of-truth]]) — so the vault passphrase is a **separate** secret, set and entered
  inside the Secret Manager and **decoupled from any IdP password reset**. The passphrase itself is
  **never** persisted or logged (§10); the server stores only the **encrypted** private-key blob.
  **This is the first Argon2 / asymmetric path in the repo** — see §1's accepted audit cost.
- **A SECOND wrapping of the private key under a `recovery key`** — a one-time, high-entropy code in the
  format **`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`** (5 alnum groups), generated client-side, **shown ONCE**
  (the [[0048-service-accounts]] shown-once precedent), and **never logged or persisted in clear**
  (only the recovery-key-wrapped private-key blob is stored).

**Reading a secret** is therefore a client-side chain: *unlock the private key with the vault passphrase (or
the recovery key) → use the private key to unwrap the vault DEK from your `VaultMembership` row →
decrypt the `SecretItem` ciphertext with the DEK.* **No server-side `reveal()`** and **no env master
key** ever unlocks a value — the deliberate inversion of `secret.service.ts`, where `reveal()` exists
and `WORKFLOW_SECRET_KEY` is the linchpin. Here the server is a **ciphertext custodian**, not a
decryptor.

> [!info] Where the crypto runs
> Unwrapping and decryption happen **client-side** (the vault passphrase / recovery key / unwrapped private
> key / DEK never leave the browser in clear). The server's job is to **store and serve** public
> material, wrapped blobs, and ciphertext — and to enforce the *authorization* layer (§7) over which
> rows you may fetch. It is structurally incapable of producing a plaintext value.

### 4. Membership = a wrapped DEK

A **`VaultMembership`** row says "user U is a crypto member of vault V" **and carries the vault DEK
wrapped to U's public key**. It is a **current-state join** (like [[article-link]]): `cuid()`,
**`createdAt`** (+ `updatedAt` only if the wrapped blob is re-written on a peer-reset, §6),
`(vaultId, userId)` **partial-unique `WHERE "deletedAt" IS NULL`**.

**Granting** a new member is a **client-side re-wrap**: a *current* member unwraps the DEK with their
own private key, then re-wraps it to the **new member's public key** and posts that wrapped blob as a
new `VaultMembership` row. The server only ever sees **wrapped** DEKs. The decisive consequence:

> **You can't grant what you can't read.** To add someone to a vault you must yourself be able to
> unwrap its DEK. The server cannot mint a membership for a vault it cannot decrypt, and ADMIN cannot
> conjure access to a vault they were never wrapped into.

This is the **same no-escalation principle** as [[0060-kb-folder-access-control]] (INV-9: "you can
never alias/share an article you cannot yourself access") — bound here at the *crypto* layer rather
than the authorization layer. Folder ACLs gate which articles you *see*; vault membership gates which
vaults you can *decrypt*; both refuse to let you hand out access you don't hold.

### 5. Revocation

**v1 = soft revoke: DROP the member's `VaultMembership` row** (the wrapped-DEK copy). The member can no
longer fetch a wrapped DEK from the server, so they can no longer unwrap the vault → no new decryptions.
This is the operationally simple, audit-clean default.

**Hard revoke** — *rotate the DEK and re-encrypt every `SecretItem` value under the new DEK, then
re-wrap the new DEK to all remaining members* — is **deferred** to a later phase and recorded as
**accepted debt**. It exists to defeat a member who **cached the DEK or a plaintext value before being
dropped**: soft revoke does not retroactively un-tell a secret the ex-member already decrypted (the
same truth as un-sharing any password). v1 ships soft revoke; the runbook for a *confirmed* compromise
is the manual one — **change the underlying credential** (rotate the actual root password), which is
the only real remediation regardless of crypto. The DEK-rotation machinery is a Phase-2 follow-up.

### 6. Peer-reset (recovery without the server learning a passphrase)

If a member loses **both** their vault passphrase **and** their recovery key, they cannot unlock their own
private key — so their existing wrapped DEKs are dead to them. Recovery is a **peer re-wrap**:

1. The member sets a **NEW vault passphrase**, which mints a **NEW `UserKeypair`** (new public key; the
   privateKey re-wrapped under `Argon2id(new vault passphrase)` + a fresh recovery key shown once). The
   old keypair is replaced. An **IdP-side login-password reset does NOT touch the vault envelope** (and
   vice-versa) — the two credential lifecycles are independent.
2. For **each vault they should regain**, **any current member** re-wraps that vault's DEK to the new
   public key (exactly the §4 grant flow) → a fresh `VaultMembership` blob.

Recovery happens **without anyone learning the user's vault passphrase** and **without the server ever holding
a key over a value** — a peer simply re-issues the wrapped DEK to the new public key.

> [!danger] A single-member vault that loses both vault passphrase and recovery key is PERMANENT, irrecoverable loss
> Zero-knowledge has no back door. If the **only** member of a vault loses **both** their vault passphrase and
> their recovery key, **no one — not a peer, not ADMIN, not the server — can ever decrypt that vault
> again.** There is no peer to re-wrap the DEK, and the server holds no key over the value. This is the
> sharp, inherent cost of the guarantee, and the **opposite** of the workflow store, which is
> recoverable-by-re-entry (lose `WORKFLOW_SECRET_KEY`, re-type the connector tokens — [[backups]]).
> The product mitigations are **the recovery key (shown once — store it off-host)** and **adding a
> second member to any vault that matters** before it is too late; the UI must nudge both. The server
> cannot rescue you.

### 7. Two authorization layers (capability ⟂ crypto membership)

Access to the Secret Manager is governed by **two orthogonal layers that can disagree**:

1. **RBAC capability — the new `secret` domain** in the permission catalog
   ([[0046-roles-permissions-v2]]): `secret:read` / `secret:manage`, **ADMIN-only by default** — the
   **same separation-of-duties precedent** as `workflow:secrets` being kept distinct from
   `workflow:manage` (`packages/shared/src/schemas/permission.ts`). This gates **ENTERING** the Secret
   Manager at all (seeing that vaults exist, reaching the endpoints).
2. **Per-vault crypto membership** — holding a wrapped DEK (a `VaultMembership` row, §4). This gates
   **DECRYPTING** a given vault.

They are **independent and may disagree**, and the ADR calls this out explicitly:

- Holding `secret:read` / `secret:manage` grants **no plaintext** — without a wrapped DEK you can list
  vault names and members but decrypt nothing.
- **Removing the capability does NOT cryptographically revoke an already-wrapped DEK.** If someone held
  membership and you strip their `secret` permission, the server will refuse their API requests — but
  the wrapped DEK they already hold (or cached) is still mathematically valid. **Capability revocation
  is an authorization fence, not a crypto revocation;** to crypto-revoke you must drop the membership
  (§5) and, for a true compromise, rotate the credential. The UI must not imply that removing the
  permission shreds the key.

> [!warning] INV-8 exception, stated sharply
> ADMIN omnipotence (INV-8) holds over **authorization and visibility**: an ADMIN can see every vault's
> **name and member list**, manage who holds the `secret` capability, and read all the *metadata*. It
> does **NOT** extend to **cryptographic plaintext** — an ADMIN who was never wrapped into a vault
> cannot decrypt its values, and there is no server-side `reveal()` for them to call. This is a
> deliberate, bounded exception to INV-8: **there is no plaintext on the server for a capability to
> unlock** (INV-10). ADMIN god-mode over the KB ([[0060-kb-folder-access-control]]) is consistent with
> INV-8; ADMIN exclusion from secret *values* here is the sharp carve-out.

### 8. KB inline reference — the masked chip

A KB article ([[article]]) may **inline-reference** a secret with a reserved token
**`{{ lazyit_secret.XXXX }}`** (where `XXXX` is the secret's server-visible **handle**, not its value).
At render time ([[0029-untrusted-content-sanitization]] — sanitization and now secret-resolution are
**render-time, not write-time**) the token becomes a **masked chip**; clicking it and supplying the
vault passphrase performs the §3 client-side decrypt chain and reveals the value **in place, in the browser**,
never round-tripping plaintext through the server.

- **Autocomplete may list secret HANDLES** (server-visible metadata, §9) but **NEVER values** — typing
  `{{ lazyit_secret.` offers the labels of secrets in vaults the author may reach, nothing more.
- **Referencing requires access to BOTH** the article (its [[folder]] ACL, [[0060-kb-folder-access-control]]
  / INV-9) **AND** the secret's vault (crypto membership, §4). A reader who can open the article but is
  not a vault member sees a **locked chip** they cannot reveal — the no-escalation principle end to end:
  embedding a secret in an article never widens who can decrypt it.
- The token is **stored verbatim** in the article markdown (write-raw, [[0029-untrusted-content-sanitization]]);
  it is **inert text** until the render layer resolves it, so it can never become a stored-XSS or a
  stored-plaintext sink.

### 9. What is / isn't zero-knowledge (the explicit line)

| Server-VISIBLE (stored / shown / logged-as-metadata) | Zero-knowledge — server NEVER sees |
| --- | --- |
| Vault **name**, member **list** | Secret **values** (plaintext) |
| Secret **handle / label** | **Passwords** |
| **Ciphertext** + `iv` + `authTag` + `keyVersion` | **Recovery keys** |
| **Public keys**, all **wrapped DEK** blobs, the encrypted private-key blobs | **Unwrapped private keys** and **unwrapped DEKs** |

Everything in the right column is **only ever in plaintext on the client**, transiently. The server is a
custodian of the left column and is **structurally incapable** of producing the right column.

### 10. Logging / never-log / disaster recovery

- **Never log** a secret value, a private key (wrapped or unwrapped), a DEK (wrapped or unwrapped), a
  vault passphrase, or a recovery key — cite [[0031-logging-strategy]] (metadata-only, bodies-not-logged, header
  redaction). A **decrypt-failure error carries NO plaintext and NO key material** — it mirrors
  `secret.service.ts`'s `reveal()` catch ("authentication failed or wrong key", no payload in the
  message). Audit rows record **who acted on which vault/item** (metadata), never the value.
- **DR:** the **recovery key is the user's PERSONAL, off-host, shown-once DR artifact** — it is the
  zero-knowledge analogue of `ZITADEL_MASTERKEY`/`WORKFLOW_SECRET_KEY` in [[backups]], except it is **per
  user and never on the host**, so a DB + `.env` restore **does NOT** make the vaults readable. Restoring
  the database brings back ciphertext, public keys, and wrapped blobs — **not** the ability to decrypt;
  that still requires a member's vault passphrase or recovery key. [[backups]] will be updated to add a
  zero-knowledge row to the DR inventory: *"Secret Manager values survive a DB restore as ciphertext;
  they are readable only by a surviving member's vault passphrase or off-host recovery key — the server cannot
  re-enter them, unlike the workflow key."*

### Migration surface (documented, NOT built here)

New tables: **`SecretVault`**, **`SecretItem`**, **`VaultMembership`**, **`UserKeypair`**
(crypto-column shapes mirroring [[workflow-secret]]; the partial-unique indexes and at-most-one/XOR
guards as raw-SQL per [[0041-soft-delete-reuse-and-restore]] / the ADR-0048 belt-and-suspenders CHECK
pattern). New permission-catalog **`secret` domain** (`secret:read` / `secret:manage`, ADMIN-only seed)
in `packages/shared/src/schemas/permission.ts` + the golden-test matrix. **No code, schema, or migration
is written in this ADR** — this is the contract the implementation slice (#366) is built against.

## Threat & loss model

**In scope (what zero-knowledge defends against):**

- **A leaked database dump.** Yields ciphertext, public keys, encrypted private-key blobs, and wrapped
  DEKs — **no plaintext**. Without a member's vault passphrase (Argon2id-derived) or recovery key, none of it
  decrypts. This is the headline win over [[workflow-secret]], where a DB + `WORKFLOW_SECRET_KEY` dump
  yields every connector credential in clear.
- **A compromised host / leaked `.env`.** There is **no env master key over values** to leak (the
  inversion of `WORKFLOW_SECRET_KEY`). The host holds wrapped blobs only.
- **An over-privileged or malicious ADMIN.** INV-8 makes ADMIN omnipotent over authorization, **not**
  over plaintext (§7). An ADMIN never wrapped into a vault cannot read it; there is no `reveal()` to
  call. (An ADMIN *can* still see vault names/members and manage capabilities — that is metadata, §9.)
- **A subpoena / insider with DB+env access.** The operator genuinely *cannot* produce a value they
  were not wrapped into — the server holds no key. (This is a feature, and a responsibility — note it
  to the deploying org.)

**Out of scope / accepted residual risk:**

- **A compromised member endpoint** (keylogger / malware on a member's machine, or a hostile browser
  extension). Zero-knowledge protects the *server and storage*, not a fully-owned client; a member who
  can decrypt is a member who can leak. This is irreducible — the same as any password manager.
- **A cached DEK or plaintext after a soft revoke (§5).** Dropping the membership stops *new* server
  reads but does not un-tell what was already decrypted; hard revoke (DEK rotation) is deferred, and a
  *confirmed* compromise is remediated by rotating the **actual** credential.
- **A weak vault passphrase.** The private key is only as strong as `Argon2id(vault passphrase)`; a
  guessable passphrase weakens the envelope for that user. Argon2id's memory-hardness raises the cost,
  and the recovery key is high-entropy, but passphrase policy still matters.
- **Metadata leakage.** Vault names, member lists, and secret handles are server-visible by design (§9)
  — name vaults and handles **without** putting the secret in the label.

**Loss model (no back door — this is the cost of the guarantee):**

- **Lose your vault passphrase, keep your recovery key** → unlock the private key with the recovery
  key, then reset the passphrase (§3). Recoverable.
- **Lose both, but the vault has another member** → **peer-reset** (§6): set a new vault passphrase (new
  keypair) and have a peer re-wrap the DEK to your new public key. Recoverable, without anyone learning
  your passphrase.
- **Lose both on a single-member vault** → **PERMANENT, irrecoverable loss** (§6 `[!danger]`). No peer,
  no server, no ADMIN can decrypt it. The mitigations are the shown-once recovery key (stored off-host)
  and never leaving a vault that matters single-member.

## New invariant (INV-10)

This ADR introduces **INV-10**, now recorded in [[INVARIANTS]] (the next free id after INV-1..8 +
INV-SA-1..4). Verbatim:

> **INV-10 (ADR-0061): Secret Manager values are zero-knowledge** — the server never holds a key that
> decrypts a secret VALUE (no server-side reveal(), no env master key over values). Granting wraps the
> DEK to a member's public key (**no grant-what-you-can't-read**). The recovery key and unwrapped
> private key are shown/derived once and never logged or persisted in clear. ADMIN omnipotence (INV-8)
> is over **authorization/visibility**, never cryptographic plaintext.

It **binds to** but does not overload its neighbours:

- **INV-9** ([[0060-kb-folder-access-control]]) — the no-escalation principle ("you can never
  alias/share an article you cannot yourself access") is the authorization-layer twin of INV-10's
  crypto-layer **"no grant-what-you-can't-read"** (§4). §8's masked chip requires *both* (article ACL
  **and** vault membership).
- **INV-8** — INV-10 is its explicit, bounded **exception over plaintext** (§7): ADMIN stays omnipotent
  over authorization/visibility; it gains nothing over cryptographic plaintext.
- **INV-6** is **not** overloaded — it is INFRA-secret-files scoped (the `zitadel_secrets` volume,
  `chmod 600`). For redaction / never-log this ADR cites [[0031-logging-strategy]] (§10); for the
  zero-knowledge contract it proposes the **new** INV-10.

## Consequences

- **Positive:**
  - A **genuinely zero-knowledge** human secret store: a leaked DB dump or `.env`, a compromised host,
    an over-privileged ADMIN, and a subpoena all yield ciphertext, not plaintext (Threat model). This is
    a property neither [[workflow-secret]] nor any prior store offers.
  - **Per-member, per-vault blast-radius containment** — compromising one member exposes only the vaults
    that member was wrapped into; there is no org-wide master key to steal (the rejected option).
  - **No-escalation end to end** (§4/§8): you cannot grant a vault you cannot decrypt, and embedding a
    secret in a KB article never widens who can read it — the crypto twin of [[0060-kb-folder-access-control]]'s
    INV-9.
  - **Two clean, orthogonal layers** (capability ⟂ crypto, §7) reuse the existing `workflow:secrets`
    SoD precedent and the frozen RBAC catalog; the masked chip (§8) reuses render-time resolution
    ([[0029-untrusted-content-sanitization]]) so the KB never becomes a weaker secret store.
  - Entity conventions reuse the codebase exactly: `cuid()` + soft-delete for the mutable vault/item;
    crypto columns mirror [[workflow-secret]]; partial-unique indexes per [[0041-soft-delete-reuse-and-restore]];
    shown-once per [[0048-service-accounts]].
- **Negative / trade-offs (accepted):**
  - **A third secret store and lazyit's first Argon2 / asymmetric / envelope crypto path** — a new,
    security-critical code path to **audit and test thoroughly** (§1), distinct from the two existing
    AES-GCM/SHA-256 paths. Accepted as the only honest way to deliver server-can't-read.
  - **No back door, by design** — a single-member vault that loses both vault passphrase and recovery key is
    **permanently lost** (§6 `[!danger]`). Unlike the workflow key, the server cannot re-enter it.
    Accepted; mitigated by the shown-once recovery key and a "add a second member" nudge.
  - **Soft revoke does not crypto-revoke** (§5) — a dropped member who cached the DEK keeps what they
    decrypted; **hard revoke (DEK rotation) is deferred** (accepted debt). A confirmed compromise is
    remediated by rotating the underlying credential.
  - **Capability ≠ crypto** (§7) — removing the `secret` permission does not shred an already-wrapped
    DEK; the UI must not imply otherwise. The two layers can disagree and that has to be taught.
  - **Metadata is server-visible** (§9) — vault names, members, and handles are not zero-knowledge;
    operators must name them harmlessly.
  - **Client-side crypto** shifts complexity to the browser (key handling, Argon2id in-page) and makes
    a compromised member endpoint the residual threat (Threat model, out-of-scope).
- **Follow-ups:**
  - The **#366 implementation slice** (the four tables, the `secret` permission domain + golden test,
    the client-side crypto, the masked-chip render path) — built against this contract.
  - **Hard revoke / DEK rotation** (§5) — the deferred Phase-2 machinery to defeat a cached DEK.
  - **[[backups]] update** — add the zero-knowledge DR row (§10): values survive a restore as ciphertext,
    readable only by a surviving member's vault passphrase or off-host recovery key.
  - The new domain entity notes — [[secret-vault]], [[secret-item]], [[vault-membership]], [[user-keypair]]
    — and the [[INVARIANTS]] INV-10 addition.

**Related:** [[0054-applications-workflow-engine]] · [[workflow-secret]] · [[0046-roles-permissions-v2]] ·
[[0031-logging-strategy]] · [[0029-untrusted-content-sanitization]] · [[0048-service-accounts]] ·
[[0060-kb-folder-access-control]] · [[0059-kb-folders-links-and-import]] · [[secret-vault]] ·
[[secret-item]] · [[vault-membership]] · [[user-keypair]] · [[folder]] · [[article]] · [[user]] ·
[[backups]] · [[INVARIANTS]] (INV-6 / INV-8 / INV-10)
