---
title: "ADR-0038: JIT user provisioning on first OIDC login"
tags: [adr, auth, oidc]
status: accepted
created: 2026-05-27
updated: 2026-06-20
deciders: [Joaquín Minatel]
---

# ADR-0038: JIT user provisioning on first OIDC login

## Status

accepted — 2026-05-27. Implements Phase 2 of the auth plan outlined in [[0037-idp-choice-zitadel-byoi]]
and replaces the `X-User-Id` shim ([[0022-draft-visibility-auth-shim]], [[0024-asset-assignment-actor-shim]])
for all actor-tracked operations.

> **Amendment 2026-05-27 — userinfo enrichment (issue #59).** The JIT path now enriches the new
> User's profile from the standard OIDC **userinfo endpoint**, because an OAuth *access token*
> carries authorization, not identity (only `sub`/`aud`/`client_id`/`exp` — not `email`/`name`).
> See the "userinfo enrichment" subsection under Decision below.

> **Amendment 2026-06-01 — account linking by verified email.** When the `sub` lookup misses, the
> JIT path now **links the new identity to an existing UNCLAIMED user that already holds the same
> (normalized) email** instead of always creating a fresh row. This is what lets the seeded
> `admin@lazyit.local` (created with `externalId = null`) be adopted by the operator's IdP identity
> on first login — without it, the create collided with the seeded row's live-email unique index and
> **every authenticated request 409'd**. See the "Account linking by verified email" subsection below.

## Context

[[0016-auth-strategy-deferred]] established that `User.externalId` (nullable, unique) is reserved for
the IdP `sub` claim, to be written when real auth lands. [[0037-idp-choice-zitadel-byoi]] chose Zitadel
as the default bundled IdP and defined the BYOI contract (three env vars: `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`). This ADR decides what happens on the *first authenticated request* from a user
who does not yet have a `User` row in lazyit.

For the target operator (a 5–20-person IT team), the IdP is the gating control: the team admin controls
who gets an account in the IdP. Once someone has an IdP account, they should be able to log into lazyit
immediately — no separate admin step to "add a user to lazyit" before their first login.

Two options were evaluated:

- **Option 1 — JIT auto-provision**: on the first valid OIDC token with an unknown `sub`, automatically
  create a `User` row from the token claims. No pre-registration in lazyit required.
- **Option 2 — Admin pre-provision**: reject requests from unknown `sub` with 401 until an admin
  explicitly creates the user in lazyit (matching the `externalId` ahead of time).

## Considered options

- **Option 1 — JIT auto-provision** — the guard creates the User on the spot when `externalId = sub`
  is not found. Simple UX: login to lazyit "just works" once the IdP account exists.
  Assumption: **the IdP is trusted** — an admin controls who has an IdP account, so anyone who
  can obtain a valid token is allowed in lazyit.
- **Option 2 — Admin pre-provision** — stricter; admin explicitly creates the user in lazyit before
  first login. Useful when lazyit access should be a subset of IdP users (e.g. not every AD user
  gets a lazyit account). More operational friction for the 5–20-person target audience.

## Decision

**Option 1 — JIT auto-provision** (CEO decision).

On the first authenticated request bearing a valid OIDC Bearer JWT with an unknown `sub`:
1. The guard creates a new `User` row with:
   - `externalId = sub` (the IdP's stable identifier)
   - `email = email` claim
   - `firstName` / `lastName` from `given_name` + `family_name` claims; fall back to splitting the
     `name` claim on whitespace; last resort: the `email` local-part. **Both names are then
     hardened** (`coerceName`): trimmed, capped at 100 chars, and any field still empty (a
     whitespace-only `given_name`, a single-token `name`, or the email-local-part path that left no
     last name) falls back to the email local-part (then `sub`). This guarantees the JIT row
     satisfies the same `@lazyit/shared` `User` contract (`firstName`/`lastName` `.min(1).max(100)`)
     as an API-created user, so a sparse IdP profile can never persist a row the schema would reject
     (round-2 correctness).
   - `isActive = true`
2. The new User is set on `request.user` and the request proceeds normally.

Subsequent requests with the same `sub` look up the existing User by `externalId` (indexed, unique)
and skip creation.

**Claims mapping**:

| OIDC claim | `User` field | Fallback |
| --- | --- | --- |
| `sub` | `externalId` | — (required) |
| `email` | `email` | `sub@unknown` (guard never fails on missing email) |
| `given_name` | `firstName` | split `name`; email local-part (never empty after `coerceName`) |
| `family_name` | `lastName` | remainder after first word of `name`; email local-part (never empty after `coerceName`) |

**userinfo enrichment (amended 2026-05-27, issue #59):**

The OIDC *access token* validated by the guard is an authorization credential — per OIDC Core it
carries `sub`/`aud`/`client_id`/`exp`, **not** the profile claims (`email`/`name`/`given_name`/
`family_name`). Provisioning from the token alone therefore produced placeholders (`firstName = sub`,
`email = sub@unknown`). To get real identity, on the **JIT path only** (unknown `sub`) the guard now
calls the standard OIDC **userinfo endpoint** with the access token as Bearer, merges those claims
*over* the token claims, and then applies the same resolution in the table above.

- **Endpoint discovery, not a hardcoded path.** The userinfo endpoint is resolved from the OIDC
  Discovery document (`${OIDC_ISSUER}/.well-known/openid-configuration` → `userinfo_endpoint`),
  consistent with [[0037-idp-choice-zitadel-byoi]] §3 (the backend speaks generic OIDC; no
  vendor-specific path). The resolved endpoint is cached at guard-instance scope (like the JWKS set),
  so repeated provisions do not re-run discovery.
- **No new env var.** The internal-origin rewrite reuses the existing `OIDC_JWKS_URI` signal: when it
  is set (the Docker split-DNS case where the API reaches the IdP at an internal URL), the discovery
  and userinfo requests are rewritten to `new URL(OIDC_JWKS_URI).origin` and carry `X-Forwarded-Host`/
  `X-Forwarded-Proto` derived from `OIDC_ISSUER` (so the IdP resolves its instance from the canonical
  host). When `OIDC_JWKS_URI` is unset, the externally-advertised endpoint is used directly with no
  rewrite and no forwarded headers — mirroring exactly the guard's existing JWKS conditional.
- **Fail-soft.** Any discovery/userinfo failure (network error, non-2xx, malformed JSON, missing
  `userinfo_endpoint`) is logged at **warn** level and falls back to the current placeholder behavior.
  Login is never blocked by a userinfo failure.
- **Existing users skip it entirely.** A request whose `sub` already maps to a `User.externalId`
  returns the existing row without any discovery/userinfo round-trip.

**Account linking by verified email (amended 2026-06-01):**

When the `externalId = sub` lookup misses, the guard does **not** immediately create a fresh row.
It first checks — using the **normal soft-delete-filtered Prisma client**, so only LIVE rows match —
whether a user already holds the resolved (trim + lowercase, ADR-0041) email. The decision tree:

| Existing live row with that email | Action |
| --- | --- |
| none | create a fresh User (unchanged behavior) |
| `externalId IS NULL` (unclaimed) | **CLAIM it**: bind `externalId = sub` onto that row, **preserve its existing role**, and return it. Optionally refresh `firstName`/`lastName` from the claims *only* when the stored name is a seed placeholder (`Admin User`) and real claims are present — a real human name is never overwritten. |
| `externalId === sub` | return it (defensive; the `sub` lookup normally caught this already) |
| `externalId` is a **DIFFERENT** sub | **409 `ConflictException`** — refuse. Never re-bind an already-linked account. |

This is the bootstrap path for the seeded ADMIN: the seed inserts `admin@lazyit.local` with
`role = ADMIN, externalId = null` (ADR-0040). An operator creates a Zitadel user with that **same
email**; their first login lands on the "unclaimed" branch, binds their `sub`, and **inherits the
ADMIN role**. Before this amendment the guard tried to `upsert` a new row with the same email,
hitting the live-email partial unique index (P2002 → 409) on **every** request.

The claim is **race-safe**: it is an `updateMany` guarded by `{ id, externalId: null }` followed by a
refetch. Two genuinely-concurrent first logins for the same email resolve to exactly one binding —
the loser's `updateMany` matches 0 rows, it refetches the now-linked row, and the flow is idempotent
(if the winner bound a *different* sub, the loser gets the 409 instead of silently overwriting).

> [!warning] Security — why email linking is safe here, and only here
> Linking by email is sound **only** under the trusted-IdP assumption (ADR-0037/0038): the admin
> controls the IdP and the IdP owns/verifies the email. **Three invariants** keep it from becoming an
> account-takeover primitive: **(1)** a row is claimed **only** when its `externalId IS NULL` (no
> identity has bound it yet), **(2)** a row already linked to a different `sub` is **never** re-bound
> — the guard 409s, and **(3) the IdP must have verified the email** (`email_verified === true` or
> `=== 'true'`) — the guard **code-enforces** this (SEC-020, `jwt-auth.guard.ts` `jitProvision`): an
> unverified email throws `ForbiddenException (403)` and the claim is refused, so no attacker can
> inherit a row's role by self-registering with an unverified address at a permissive IdP. The
> email lookup runs through the soft-delete-filtered client, so a soft-deleted / offboarded user
> with the same email is invisible and can never be linked or resurrected (the no-resurrect posture
> of the `externalId` path is preserved end-to-end).

**Library**: `jose` (standard OIDC / JWKS; no Passport, no NestJS-passport). userinfo + discovery
use the runtime's `fetch` directly — no additional dependency.

**Guard strategy**: a plain `CanActivate` guard registered globally via `APP_GUARD` in `AuthModule`.

**AUTH_MODE=shim**: when `AUTH_MODE=shim` (dev/test), the guard reads `X-User-Id` header, resolves
the User by UUID, and sets `request.user`. Absent header → `request.user = undefined`; no 401.
The shim is preserved so existing dev tooling and tests continue to work without OIDC infrastructure.

**Assumption**: the IdP is fully trusted. The admin controls who holds an IdP account, which is the
effective access gate. lazyit does not add a second gate. If a customer needs stricter control, see
the Future option below.

## Consequences

- **Positive:**
  - Zero-friction first login: after the Zitadel account exists, the user can immediately access lazyit
    with no admin action in lazyit.
  - `User.externalId` is populated on first login — `externalId` is no longer null for IdP-linked users.
  - All actor-tracked operations (asset history, assignments, access grants, consumable movements, KB
    authorship) automatically record the real User id from the JWT.
  - The `X-User-Id` shim (`AUTH_MODE=shim`) is preserved for local dev/test without OIDC infra.

- **Negative / trade-offs:**
  - **Trusted-IdP assumption**: if the IdP admin grants someone an account, lazyit grants them access.
    There is no per-application "allowlist" in lazyit itself.
  - A user's `firstName`/`lastName`/`email` are sourced from OIDC claims (token + userinfo) at
    provisioning time and are **not** automatically synced on subsequent logins (updating those
    fields is out of scope for Phase 2).
  - Placeholders (`firstName = sub`, `email = sub@unknown`) are now only used if **both** the access
    token and the userinfo response lack the profile/email claims (or userinfo is unreachable). For
    real profiles the operator must ensure the IdP grants the `profile`+`email` scopes so userinfo
    returns them (the default Zitadel setup does).
  - The JIT path performs **two extra HTTP calls** on first login per user (discovery — cached after
    the first — and userinfo). These are off the hot path: existing users never trigger them.

- **Follow-ups:**
  - **Phase 3 (frontend)**: wire Auth.js (or equivalent) in the Next.js app to initiate the OIDC flow
    and attach the Bearer token to API calls.
  - **Profile sync** (future, optional): a post-login hook that updates `firstName`/`lastName`/`email`
    from the latest OIDC claims — so profile changes in the IdP propagate to lazyit.
  - **Admin approval mode** (future, opt-in): if a customer wants stricter access control (only a
    subset of IdP users can log in), add a flag `USER_PROVISIONING_MODE=manual` that rejects unknown
    `sub` with 403 and requires an admin to pre-create users with the correct `externalId`.
  - ADR-0022 (`X-User-Id` shim for KB visibility) and ADR-0024 (actor shim for assignments) are
    superseded in the OIDC path by this ADR. `AUTH_MODE=shim` keeps them functional in dev.

Related: [[0016-auth-strategy-deferred]] · [[0022-draft-visibility-auth-shim]] ·
[[0024-asset-assignment-actor-shim]] · [[0037-idp-choice-zitadel-byoi]] · [[user]] · [[auth-bootstrap]]

---

## Amendment — directory-person promotion (Etapa 2, 2026-06-20)

> Amends the "Account linking by verified email" section. The import (ADR-0069 Etapa 2) creates `User`
> rows with `directoryOnly = true` (persons without login, without Zitadel mirror). This amendment
> extends the JIT linking path so that an OIDC first-login that hits one of these rows **promotes** it
> to a full account.

### Directory-person promotion path

When the `externalId = sub` lookup misses and the email-link lookup finds a **live row** with
`externalId IS NULL`, the standard claim logic applies — but the row may now be a directory person.
The `updateMany` that binds `externalId = sub` gains an additional field: **`directoryOnly: false`**.
The promoted row inherits its existing `role` (VIEWER, the forced default for directory persons) and
all existing `AssetAssignment`s and history. No other changes to the claim logic.

**Key rules (unchanged from ADR-0038 / INV-2):**

- Linking is claim-only: `externalId IS NULL` rows only; soft-deleted rows are invisible.
- Verified email is still the **sole linking key** (`email_verified === true` enforced by the guard).
- `username` and `legajo` are **NOT** linking keys. A person identified only by legajo or username has
  a synthesized `@directory.local` placeholder email and can **never** auto-promote via OIDC.
- A row already linked to a different `sub` is refused (409) — no re-bind.

### Manual provision-account path

An ADMIN can promote a directory person explicitly without waiting for a first login via
`POST /users/:id/provision-account` (ADR-0069 §A.4). This takes a **real email** (required — Zitadel
will not accept a `@directory.local` placeholder), writes to the IdP first, then sets `externalId` and
`directoryOnly = false` locally. If the local step fails after a successful IdP write, the next JIT
login with the same verified email will reconcile (the unclaimed row is now email-linkable).

### No change to INV-2

Email remains the **only** account-linking key. `username` and `legajo` are directory/display handles
(ADR-0058) — they allow dedup within the import session but confer no OIDC linking capability. A
directory person without a real email is permanently non-promotable via the auto-JIT path.

**Related:** [[0069-migrator-import]] · [[0069-migrator-import.REDESIGN]] · [[user]] · [[INVARIANTS]]
