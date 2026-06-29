---
title: "ADR-0075: Typed secrets via client-side structured payload + server-visible `kind` metadata"
tags: [adr, secrets, security, metadata]
status: accepted
created: 2026-06-28
updated: 2026-06-28
deciders: [Joaquín Minatel]
---

# ADR-0075: Typed secrets via client-side structured payload + server-visible `kind` metadata

## Status

**accepted** — 2026-06-28. Issue #838. Backend + shared contract + migration shipped (this change);
the typed forms, TOTP code generation, and typed renderers build against the contract below on the
frontend. Extends [[0061-secret-manager-zero-knowledge]] without touching its crypto path.

## Context

The Secret Manager ([[0061-secret-manager-zero-knowledge]]) stores every value as one opaque
AES-256-GCM envelope (`ciphertext`/`iv`/`authTag`/`keyVersion`) that the **server can never decrypt**
(INV-10 — the server is a ciphertext custodian; there is no `reveal()`/`decrypt()`/`unwrap()`, no
master key, and the `inv-10.guard.spec.ts` merge-gate statically forbids importing any cipher into the
module). Today every secret is treated as a single plaintext string.

Operators want **typed** secrets — an SSH key (private/public/passphrase), a TOTP seed (with code
generation), an X.509 certificate (cert/key/chain) — each with the right form to enter it and the
right surface to render it. The audit vocabulary already anticipates these types.

The hard constraint: a typed secret must **not** leak any structure of the value to the server. The
server already sees `handle` and `label` as metadata; it must see nothing more about the value.

## Decision

### 1. A "typed secret" is a CLIENT-SIDE JSON encoding inside the SAME ciphertext

A typed value is just a structured JSON object that the **client** serializes (`JSON.stringify`) →
encrypts into the exact same opaque envelope as today. The server stores the identical
`ciphertext`/`iv`/`authTag`/`keyVersion` columns and is structurally just as blind to a typed payload
as to a plain string. **No crypto-path change, no new value column, no server-side payload
validation** (the server literally cannot see the payload to validate it).

### 2. The ONLY server-visible addition: a `kind` metadata enum

A new `SecretItem.kind` column — a Prisma enum `SecretItemKind { GENERIC SSH_KEY TOTP CERTIFICATE }`,
**`@default(GENERIC)`, NOT NULL** — is **metadata only**, the same trust class as `handle`/`label`. It
tells the UI which form/icon/renderer to use **without decrypting**. It never describes the plaintext,
only how the client should encode and later parse/render it.

- `GENERIC` = a plain string value — the **legacy + back-compat default**. Every existing row
  backfills to `GENERIC` via the column default; every existing create that omits `kind` stays
  `GENERIC`. So the change is purely additive — no migration of envelopes, no client break.
- `kind` is **mutable** (a secret can be re-typed via PATCH — e.g. promoting a `GENERIC` value to
  `SSH_KEY`), which is a metadata-only edit that never touches the envelope.

### 3. The client-side payload contract (per `kind`)

These shapes are encoded/parsed **entirely in the browser**; the server stores only `kind` + the
ciphertext and validates none of them. Optional fields are omitted when empty.

| `kind`        | Decrypted JSON payload (client-only)                                          |
| ------------- | ---------------------------------------------------------------------------- |
| `GENERIC`     | a plain string (NOT JSON-wrapped) — unchanged back-compat representation      |
| `SSH_KEY`     | `{ privateKey: string, publicKey?: string, passphrase?: string }`            |
| `TOTP`        | `{ secret: string, issuer?: string, account?: string, digits?: number, period?: number, algorithm?: "SHA1" \| "SHA256" \| "SHA512" }` |
| `CERTIFICATE` | `{ certificate: string, privateKey?: string, chain?: string }`               |

`GENERIC` deliberately stays a raw string (not `{ value }`) so existing secrets decrypt unchanged. The
frontend owns the encode/parse helpers, the typed forms, TOTP code generation (RFC 6238 client-side),
and the typed render — and MAY version the JSON internally; the server is unaffected.

### 4. Contract (`@lazyit/shared`)

- New `SecretItemKindSchema = z.enum(["GENERIC","SSH_KEY","TOTP","CERTIFICATE"])` (+ inferred
  `SecretItemKind`), mirroring the Prisma enum.
- `SecretItemSchema` (read DTO) gains `kind: SecretItemKindSchema`.
- `CreateSecretItemSchema` gains `kind: SecretItemKindSchema.optional()` — optional on the wire; the
  **service** fills `GENERIC` when omitted (`dto.kind ?? 'GENERIC'`). `.optional()` rather than zod
  `.default()` keeps the inferred type optional for direct service callers; the back-compat fill lives
  in the service.
- `UpdateSecretItemSchema` gains `kind: SecretItemKindSchema.optional()` (re-typing).

The service threads `kind` through `createItem`/`updateItem` (persist only) and `itemToWire` (expose).
No crypto, no payload validation.

## Consequences

**Positive**

- Typed secrets with **zero** change to the crypto path or envelope shape — the smallest additive diff.
- INV-10 is preserved **by construction**: `kind` is metadata; the typed payload lives inside the same
  opaque ciphertext the server already cannot read. The merge-gate spec stays green (no cipher
  imported; no `reveal`/`decrypt`/`unwrap`).
- Fully back-compatible: existing rows + existing create calls are `GENERIC` automatically.

**Negative / trade-offs**

- The server can't validate a typed payload's well-formedness (e.g. that an `SSH_KEY` actually carries
  a `privateKey`) — accepted, and unavoidable: the server can't see the payload. Validation is the
  client's job at encode time.
- `kind` could disagree with the actual encrypted payload if a client lies — but that is a
  client-correctness concern, not a security boundary (the value is already client-controlled). `kind`
  is a rendering hint, never a security decision.

## Honoured invariants / related ADRs

- **INV-10** / [[0061-secret-manager-zero-knowledge]] — `kind` is metadata only; the typed payload is
  client-side JSON inside the unchanged ciphertext; no crypto added; merge-gate kept green.
- [[0005-id-strategy]] / [[0006-soft-delete-and-auditing]] — `SecretItem` shape otherwise unchanged.

## Alternatives considered

- **Per-type value columns (e.g. `privateKey`, `publicKey`)** — rejected outright: it would put typed
  plaintext structure in front of the server, a direct INV-10 violation.
- **A typed-payload zod schema validated server-side** — rejected: the server can't decrypt, so it
  can't validate; the schema is a client-side concern.
- **A free-text `type` string instead of an enum** — rejected: the four `kind`s are a small, curated,
  audit-named set; an enum gives the UI a closed switch and the DB a cheap check.
- **Encoding `kind` inside the ciphertext (no metadata column)** — rejected: the UI must pick the form
  before it can decrypt; the type hint has to be server-visible metadata, exactly like `label`.
