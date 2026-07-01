---
title: "ADR-0080: Programmatic secret retrieval via a service account (headless, client-side decrypt)"
tags: [adr, secrets, security, crypto, service-accounts, automation]
status: accepted
created: 2026-07-01
updated: 2026-07-01
deciders: [Joaquín Minatel]
---

# ADR-0080: Programmatic secret retrieval via a service account (headless, client-side decrypt)

## Status

accepted — extends [[0061-secret-manager-zero-knowledge]] (the zero-knowledge Secret Manager, INV-10)
and [[0048-service-accounts]] (the non-human principal). Issue #614; amended by #883 (auto-generate the
keypair for every SA on create + regenerate it on token rotation — no schema change, the models already
carry the 1:1 `@unique` this needs).

## Context

The Secret Manager (ADR-0061) is a **human** secret store: a member unlocks their X25519 private key with
a vault passphrase **in the browser**, unwraps the vault DEK from their `VaultMembership`, and decrypts a
`SecretItem`. The server is a **ciphertext custodian** and can NEVER decrypt (INV-10).

The CEO wants automation to reach the same secrets **headlessly** — "instead of copy-pasting them, a
deploy/CI script calls an API that brings them all" — *without* weakening the guarantee:
`"el servidor los tiene que mantener cifrados siempre"`. Today the only non-human principal is the
**service account** (ADR-0048, `lzit_sa_<id>_<secret>`), authenticated by a lazyit-native token (SHA-256
hash at rest), authorized by direct grants — but the Secret Manager is explicitly **human-only**
(`HumanOnlyGuard`, and `secret:read`/`secret:manage` are in `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS`),
precisely because a service account had **no keypair** and could never decrypt anything it was handed.

The CEO settled the shape over three comments on #614:

1. **Per-vault is the isolation unit.** A credential that decrypts **one whole vault** is acceptable *as
   long as it is scoped to that vault, never to all vaults* — `"mientras la llave maestra sea por vault y
   no para todos los vaults, está bien… si querés seguridad, creá varios vaults"`. So **no sub-vault key
   granularity** is needed; the existing one-DEK-per-vault envelope is the right unit.
2. **Token-as-keymaster residual risk ACCEPTED.** Whoever holds the SA token can decrypt that vault — this
   is inherent to *any* headless secret access (HashiCorp Vault AppRole, etc.) and is accepted, made
   explicit, and mitigated (scope per-vault, audit every read, rotation).
3. **A first-party fetch CLI is APPROVED** as the client-side decrypt tool — there must be a place outside
   the browser that unwraps.

The forces: reach the same ciphertext headlessly; decrypt **client-side** so INV-10 is untouched;
reuse the existing envelope crypto (X25519 / Argon2id / AES-256-GCM) rather than invent a second path;
keep the service account a **separate principal** (never a `User`); and audit every programmatic read.

## Decision

A service account becomes **another keypair holder**, slotting into ADR-0061's envelope model with **no
change to the crypto invariant** — the SA token plays the role the human vault passphrase plays.

### 1. The SA keypair — a separate model, token-wrapped private key

On SA creation a browser generates a fresh **X25519 keypair** (client-side) for **every** service account
— issue #883 dropped the earlier `secret:fetch`-only gate, since a keyless SA later granted Fetch (or one
created before #614) was a footgun: it could not be granted vault access and "recreating" it lost its
identity + grants. An unused keypair on a non-fetch SA is negligible cost. The private key is wrapped
**once**, under a KEK derived by **Argon2id** from the **SA token secret** (the `lzit_sa_<id>_<secret>`
plaintext, known only at mint time + to the token holder). The server stores ONLY:

- the SA **public key** (clear — DEKs are wrapped to it),
- the **wrapped private key** + its Argon2id salt/IV/params (ciphertext),
- and (already, from ADR-0048) the token **SHA-256 hash** for auth.

It stores **neither the token plaintext, nor the unwrapped private key, nor the KEK**.

**Lifecycle — regenerate on rotation (#883).** The keypair is wrapped under the token, so a **token rotation**
kills the old wrap (nobody holds the old token after the one-time reveal). On rotation the browser therefore
**re-generates the keypair under the NEW token** and it **REPLACES** the stored `ServiceAccountKeypair` in
place (1:1 `@unique`) — the same `POST …/:saId/keypair` write, now create-or-replace. This is also the
**retrofit path** for a pre-#883 keyless SA (its first keypair). Because the regenerated keypair carries a
**new public key**, every DEK previously wrapped to the old key is undecryptable, so the SA's
`ServiceAccountVaultMembership` rows are **hard-dropped in the same transaction**: the SA cleanly loses its
grants and must be **re-granted** (exactly the ADR's "rotation = re-issue keypair + re-grant" framing above).
The regeneration is client-side and token-wrapped like the create path — INV-10 is untouched.

**Fork — schema shape (decided): a dedicated `ServiceAccountKeypair` model**, NOT a polymorphic
`UserKeypair` union. ADR-0048 makes the SA a **separate principal** (not a `User`); a decoupled keypair
keeps the human zero-knowledge tables untouched and avoids nullable user/SA unions. Its wrapping table
twin, **`ServiceAccountVaultMembership`**, is likewise a dedicated model keyed to the cuid ServiceAccount.

**Why only ONE wrap (no recovery copy).** A human keypair is wrapped twice (passphrase + recovery key)
so losing one path is survivable. A service account has exactly one credential — its token. Losing it is
not a "recovery" problem; it is a **rotation** problem (re-issue the keypair + re-grant). So the SA
keypair carries a single token-derived copy. Argon2id (memory-hard) is deliberate overkill for a
256-bit-random token — it is chosen for **uniformity** with the human passphrase wrap (same
`ARGON2ID_PARAMS`, same `hash-wasm` WASM) and **defense in depth**, per the #614 fork decision (Argon2id
over HKDF).

### 2. Granting an SA → vault — the existing "no grant-what-you-can't-read" flow

A **human vault member** unwraps the DEK with their own private key and **re-wraps it to the SA's public
key**, posting a `ServiceAccountVaultMembership`. This is the ADR-0061 §4 grant flow, extended to an SA
subject. The authorization fence is unchanged: the granter must be a **live member** of the vault (so an
ADMIN who was never wrapped in cannot grant — INV-8 does not extend to crypto), and holds `secret:manage`.
The server sees only a **wrapped** DEK; it cannot mint one. "No grant-what-you-can't-read" holds.

### 3. The headless read endpoint — ciphertext only

`GET /secret-fetch/:vaultId` is the **one** Secret-Manager route a service account may reach. It is
**service-only** (`ServiceOnlyGuard` — the inverse of `HumanOnlyGuard`; even an ADMIN human is refused)
and gated on a **new, narrow verb `secret:fetch`**. It returns, for a vault the SA is a member of:

- the SA's **wrapped private key** blob (+ salt/IV/params),
- the vault DEK **wrapped to the SA** (`ServiceAccountVaultMembership`),
- every live item's **ciphertext envelope** (`ciphertext`/`iv`/`authTag`/`keyVersion` + `handle`/`label`/`kind`).

**All ciphertext or public material.** The server produces no plaintext. Every call appends exactly one
metadata-only audit row (**`ITEMS_FETCHED`** — which SA, which vault, when), **awaited before the response
is returned**, so there is no unaudited programmatic read. (This partly serves the read-audit ask of #870.)

### 4. The `lazyit-fetch` CLI — where the unwrapping happens

A small first-party CLI (`packages/fetch-cli`, `bin: lazyit-fetch`, Bun) is the **only place outside the
browser** that decrypts. Given the SA token + a vault id + the API URL it: `GET`s the endpoint →
re-derives the KEK from the token (Argon2id over the returned salt/params) → unwraps the SA private key →
unwraps the DEK → decrypts each value → emits a `.env` (or JSON / stdout). It **reuses the shipped,
merge-gated `@lazyit/shared/crypto` primitives** (`openBytes`/`unwrapDek`/`open`) — it never hand-rolls
crypto — with Argon2id from the same `hash-wasm` the browser uses. It ships a runnable **`--self-check`**
that performs the full wrap→fetch-shape→decrypt round-trip with no server, proving the chain agrees with
the shared primitives byte-for-byte.

**Distribution — a compiled standalone binary, not an npm package (#887).** `@lazyit/fetch-cli` is a
**workspace-only** package; it is deliberately **not published to a registry**, so `bunx lazyit-fetch` (or
`npx`) resolves to a 404 and a deploy/CI box with no monorepo has nothing to run. The runnable artifact is a
**Bun-compiled standalone binary**, mirroring the reporting agent (ADR-0074 §7): `bun run --filter
@lazyit/fetch-cli compile` produces `packages/fetch-cli/dist/lazyit-fetch-{x64,arm64}` via `bun build
--compile --target=bun-linux-{x64,arm64}`. The binary is self-contained (no Bun/Node on the target). For
in-repo testing the CLI still runs straight from source (`bun packages/fetch-cli/src/index.ts …`). The
Manual (`secret-manager-programmatic-access`, en+es) documents building + running the binary — never a
`bunx`/`npx` install. See follow-up (e) for serving the binary from the instance.

### 5. The new verb `secret:fetch` and the fences it widens

`secret:fetch` is the **single machine verb** for programmatic retrieval — the SA twin of the human
`secret:read`, kept **separate** so a bot never touches the human read/manage surface:

- `secret:read`/`secret:manage` **stay** in `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS` (human-only). Only
  `secret:fetch` is grantable to an SA (never `secret:*`, per #555 — scope per-vault).
- `HumanOnlyGuard` still guards **every other** secret route; the fetch route carries the inverse
  `ServiceOnlyGuard`, so the human-only fence opens for **exactly one** audited, ciphertext-only path.
- The fetch route requires the SA to also hold a **live `ServiceAccountVaultMembership`** — the same
  two-orthogonal-layers model as humans (capability ⟂ crypto membership, ADR-0061 §7).

## Why INV-10 holds — end to end

INV-10: *the server never holds a key that decrypts a secret VALUE.* It holds here because **every key
that could decrypt is either public, or ciphertext at rest, or client-only and transient**:

| Material | Where it lives | Can the server decrypt with it? |
| --- | --- | --- |
| SA public key | server, clear | No (public) |
| SA **wrapped** private key + salt/IV/params | server, ciphertext | No — needs the KEK |
| SA **token SHA-256 hash** | server, at rest | No — a one-way hash; not the token, not the KEK |
| **DEK wrapped to the SA** | server, ciphertext | No — needs the SA private key |
| Item **ciphertext** envelopes | server, ciphertext | No — needs the DEK |
| SA **token plaintext** | client only (+ transiently in the fetch request's `Authorization` header) | — |
| **KEK** = Argon2id(token) | **CLI only** | derivation never runs on the server (no crypto imported) |
| unwrapped **private key** / **DEK** / **value** | **CLI only**, transient | never on the server |

**Each unwrap happens in the CLI:** KEK (Argon2id over the token) → private key (`openBytes`) → DEK
(`unwrapDek`) → value (`open`). The read endpoint returns only the left-column ciphertext/public rows.

**At rest, a DB + `.env` dump yields nothing decryptable:** the wrapped private key needs the KEK; the
server stores only `SHA-256(token secret)`, which is a *different* one-way function from
`Argon2id(token, salt)` and cannot be reversed to the token or the KEK. This is byte-identical to the
human guarantee — a leaked dump is ciphertext, not plaintext.

**The residual (explicitly accepted).** During a **live** fetch the SA token transits the server in the
`Authorization` header (as it must — the SA authenticates with it). A *malicious/compromised* server
could, in that window, run the Argon2id+unwrap chain itself. Two things bound this: (a) the shipped API
**imports no crypto capable of it** — the **INV-10 architectural merge gate** (`inv-10.guard.spec.ts`)
statically fails CI if any `@noble/*` / `@lazyit/shared/crypto` / `node:crypto` import, or any
`reveal/decrypt/unwrap`/cipher token, appears in the secret-manager module; a new test (#6) pins the
fetch path by name; and (b) this is the **token-as-keymaster** residual inherent to any headless secret
access, accepted by the CEO. It is the one honest difference from the human flow, where the passphrase
**never** transits the server. Mitigations: **scope each SA per-vault** (never `secret:*`), **audit every
read** (`ITEMS_FETCHED`), and **rotate** the token (→ re-issue keypair + re-grant) on suspicion.

## Auditing

`SecretAuditLog` gains two soft-ref columns (no FK, like its existing `vaultId`/`itemId`/`targetUserId`)
and a raw-SQL **at-most-one-actor CHECK** (`actorId` XOR `serviceAccountId`, the ADR-0048 fork-#4 pattern):

- `serviceAccountId` — the **SA actor** on `ITEMS_FETCHED` (a bot is never a human, so `actorId` is null).
- `targetServiceAccountId` — the **SA target** on `SA_KEYPAIR_CREATED` and on an SA-subject
  `MEMBERSHIP_GRANTED`/`MEMBERSHIP_REVOKED`.

## Migration surface

New models **`ServiceAccountKeypair`** (1:1 with the cuid ServiceAccount; single token-wrapped private-key
copy) and **`ServiceAccountVaultMembership`** (`@@unique(vaultId, serviceAccountId)`, hard-drop on revoke).
Two nullable soft-ref columns + two enum values (`SA_KEYPAIR_CREATED`, `ITEMS_FETCHED`) + the one-actor
CHECK on `SecretAuditLog`. A `--create-only` migration (no reset). New catalog verb **`secret:fetch`**
(coarse tier, ADMIN-only by seed, machine-granted in practice — like `infra:report`).

## Consequences

- **Positive.** Automation reaches the same zero-knowledge secrets headlessly with **no weakening of
  INV-10** — a leaked DB/`.env` still yields ciphertext. The service account reuses the exact envelope
  crypto; the fence opens for exactly one audited, ciphertext-only, service-only path. Per-vault scoping
  bounds blast radius; every read is attributable.
- **Negative / accepted.** The **token-as-keymaster** residual (a live token can decrypt its vault; the
  token transits the server on the request). **Rotation regenerates the keypair automatically** (client-side,
  #883) but still **requires re-granting** the SA's vaults — the fresh public key orphans the old wrapped
  DEKs. A **compromised deploy box** that holds the token is out of scope (the same irreducible
  client-compromise residual as any password manager, ADR-0061 threat model).
- **Follow-ups.** (a) **Token rotation → regenerate keypair — DONE (#883).** On rotate the browser
  re-generates the keypair under the new token and it REPLACES the stored row; this is also how a pre-#883
  keyless SA is retrofitted. We chose **regenerate** (fresh keypair, re-grant required) over the originally
  sketched *same-key re-wrap* (which would preserve grants) because same-key re-wrap needs the OLD token to
  unwrap the old private key — unavailable in the rotate flow and impossible for a keyless retrofit; the
  server-side membership-drop is conditional on a changed public key, so a future same-key re-wrap would
  keep grants for free. (b) **Visually mark machine-granted vaults** so operators know a token can read them.
  (c) The export/import overlap (#612/#613). (d) A first-class `SecretAuditLog` read surface (#870).
  (e) **Serve the compiled `lazyit-fetch` binary from the instance for a one-line download (#887)** — exactly
  the reporting agent's token-gated `GET /agent/download` pattern (ADR-0074 §6, `agent-dist.controller.ts`):
  bake `lazyit-fetch-{x64,arm64}` into the API image build stage and stream it from a `secret:fetch`-gated
  route (no anonymous binary surface, version-locked to the running server). #887 added only the `compile`
  scripts + corrected the Manual; the serve endpoint is deferred to this follow-up.

---

Related: [[0061-secret-manager-zero-knowledge]] · [[0048-service-accounts]] ·
[[0075-typed-secrets-client-payload-kind-metadata]] · [[0046-roles-permissions-v2]] ·
[[secret-vault]] · [[vault-membership]] · [[user-keypair]] · [[INVARIANTS]] (INV-10) · [[_MOC]]
