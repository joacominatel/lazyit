---
title: "ADR-0038: JIT user provisioning on first OIDC login"
tags: [adr, auth, oidc]
status: accepted
created: 2026-05-27
updated: 2026-05-27
deciders: [Joaquín Minatel]
---

# ADR-0038: JIT user provisioning on first OIDC login

## Status

accepted — 2026-05-27. Implements Phase 2 of the auth plan outlined in [[0037-idp-choice-zitadel-byoi]]
and replaces the `X-User-Id` shim ([[0022-draft-visibility-auth-shim]], [[0024-asset-assignment-actor-shim]])
for all actor-tracked operations.

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
     `name` claim on whitespace; last resort: `email` local-part as `firstName`, empty `lastName`.
   - `isActive = true`
2. The new User is set on `request.user` and the request proceeds normally.

Subsequent requests with the same `sub` look up the existing User by `externalId` (indexed, unique)
and skip creation.

**Claims mapping**:

| OIDC claim | `User` field | Fallback |
| --- | --- | --- |
| `sub` | `externalId` | — (required) |
| `email` | `email` | `sub@unknown` (guard never fails on missing email) |
| `given_name` | `firstName` | split `name`; email local-part |
| `family_name` | `lastName` | remainder after first word of `name`; `""` |

**Library**: `jose` (standard OIDC / JWKS; no Passport, no NestJS-passport).

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
  - A user's `firstName`/`lastName` are sourced from OIDC claims at provisioning time and are **not**
    automatically synced on subsequent logins (updating those fields is out of scope for Phase 2).
  - If `email` is absent from the token, a placeholder (`sub@unknown`) is used; this may create a
    user with an invalid email that must be corrected manually. Operators should ensure their IdP
    includes `email` in the token.

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
