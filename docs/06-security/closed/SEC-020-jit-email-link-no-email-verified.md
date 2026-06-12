---
id: SEC-020
title: JIT email account-linking never checks email_verified → ADMIN/account takeover under BYOI
severity: high
status: fixed
cwe: CWE-287
discovered: 2026-06-06
module: users
tags: [account-takeover, auth, oidc, byoi, privilege-escalation, email-linking]
---

# SEC-020 — JIT email account-linking never checks `email_verified`

## Summary

On first OIDC login the guard binds the token's `sub` to any LIVE, unclaimed (`externalId IS NULL`)
local user that holds the same `email`, **inheriting that row's role** — but it never checks the OIDC
`email_verified` claim, so under a BYOI IdP that emits an unverified email an attacker can claim the
seeded ADMIN row (or any app-created user) and take over the account.

## Description

`jitProvision` resolves the email from the token / userinfo claims and uses it verbatim to find and
claim a local row:

- the email is read as `typeof profile['email'] === 'string' ? profile['email'] : undefined`, then
  normalized (`jwt-auth.guard.ts:376-382`). **`profile['email_verified']` is never consulted** — a
  grep for `email_verified` across `apps/api/src` returns nothing.
- if a LIVE user already holds that email and `externalId IS NULL`, the guard CLAIMS it
  (`updateMany where { id, externalId: null }`) and **preserves its existing role**
  (`jwt-auth.guard.ts:439-478`).

This is exactly the bootstrap that lets the seeded `admin@lazyit.local` (`role = ADMIN,
externalId = null`, ADR-0040) be adopted by an operator's IdP identity. The re-bind / soft-delete
guards (INV-2) are correct: a row already linked to a different `sub` 409s, and soft-deleted rows are
invisible. **But the whole linking model rests on the email being VERIFIED** — ADR-0038 literally
titles it "Account linking by **verified** email" and DEF-002 states it "is sound ONLY because the
IdP is trusted to own/verify the email." The code enforces the *trusted-IdP* half (it trusts whoever
issued the token) but not the *verified-email* half (it never checks the claim that says the email was
verified). OIDC Core §5.1 / §5.7 are explicit: the `email` claim MUST NOT be relied on unless
`email_verified` is `true`.

Two compounding factors widen the blast radius:

1. **BYOI is a first-class mode (ADR-0037).** The customer may point lazyit at any standard OIDC IdP.
   Many IdPs allow self-service registration and will happily mint a token with an arbitrary,
   *unverified* `email` claim (a misconfigured Keycloak/Auth0/Authentik realm, a Google Workspace vs.
   consumer-Gmail mix, etc.).
2. **Under BYOI every app-created user has `externalId = null`.** `UsersService.create` only persists
   an `externalId` when `idp.supportsManagement && ref.externalId` (`users.service.ts:164-175`);
   generic-oidc returns an empty ref, so all `POST /users` rows stay unclaimed and therefore
   email-claimable — not just the seed.

## Impact

An attacker who can obtain a valid OIDC token carrying an unverified `email` claim equal to a target's
email (e.g. by self-registering at the IdP with `admin@lazyit.local`) logs into lazyit once and the JIT
path binds their `sub` to the target's local row, inheriting its role. Against the seeded ADMIN this is
**full administrative account takeover** (then user:manage / accessGrant:grant / every `:delete`).
Against any unclaimed MEMBER/VIEWER it is identity takeover of that account.

Mitigating context: it is **not** unconditional — it requires the IdP to issue a token with an
unverified, attacker-chosen email. The **default bundled Zitadel** verifies email on registration, so a
stock deploy is not exploitable today; the exposure is real for BYOI deployments and for any Zitadel
instance configured to allow unverified self-registration. Rated High (a supported config + a simple
chain yields ADMIN), not Critical (config-dependent, and the shim path is unaffected).

## Proof of concept

Reasoned, **not executed** (the API/IdP are not run during review). Under `AUTH_MODE` OIDC with a BYOI
IdP that does not enforce email verification:

1. Attacker self-registers at the IdP with `email = admin@lazyit.local` (verification not enforced →
   `email_verified` absent or `false`).
2. Attacker completes the OIDC flow and calls any lazyit endpoint with the resulting Bearer token.
3. `jitProvision`: `externalId = sub` misses → email lookup finds the seeded `admin@lazyit.local`
   (`externalId = null`) → `updateMany { id, externalId: null }` binds the attacker's `sub` and
   returns the row with `role = ADMIN`.
4. Attacker is now ADMIN in lazyit.

## Affected

- `apps/api/src/auth/jwt-auth.guard.ts:376-382` — email resolved from claims; `email_verified` never
  read.
- `apps/api/src/auth/jwt-auth.guard.ts:439-478` — the email-link claim path (claims an unclaimed row +
  inherits its role) with no verification gate.
- `apps/api/src/users/users.service.ts:164-175` — BYOI leaves `externalId = null` on every
  app-created user, so all of them are email-claimable.
- Premise documents: `docs/03-decisions/0038-jit-user-provisioning.md:116-147` ("verified email"),
  `docs/06-security/INVARIANTS.md` INV-2, `docs/06-security/deferred.md` DEF-002.

## Recommendation

Before performing the email-link claim, require a verified email:

- Read `email_verified` from the merged `profile` and refuse to link unless it is strictly `true`
  (boolean `true` or the string `"true"` some IdPs emit):

```ts
const emailVerified =
  profile['email_verified'] === true || profile['email_verified'] === 'true';
// ... only enter the emailOwner claim branch when emailVerified is true
```

- When `email_verified` is not true, do **not** claim an existing row by email. Either fall through to
  creating a fresh `externalId`-bound row (no inheritance of someone else's role) or reject the login,
  per a documented decision.
- Keep the existing INV-2 guards (claim only `externalId IS NULL`, never re-bind, soft-delete-filtered)
  — this adds the missing third guard.
- Document the chosen behavior in ADR-0038 so "verified email" is enforced in code, not just asserted.

## Prevention

Treat "link accounts by email" as a security-sensitive operation that ALWAYS requires
`email_verified === true` (OIDC Core §5.7). Add a guard test that a JIT login with `email_verified`
absent/false does NOT claim an existing unclaimed row (it should fail without the check). Note the
verified-email requirement in INV-2 and DEF-002 as a *code-enforced* invariant, not an IdP assumption.

## References

- CWE-287 (Improper Authentication), CWE-290 (Authentication Bypass by Spoofing), CWE-294
  (account pre-hijacking class).
- OpenID Connect Core 1.0 §5.1 (`email_verified`) and §5.7 (Claim Stability and Uniqueness — do not
  use `email` as a key unless verified).
- ADR-0038 (JIT provisioning / email linking) · ADR-0037 (Zitadel + BYOI) · INVARIANTS INV-2 ·
  deferred DEF-002 · SEC-006 (server-owned identity linkage).

## Resolution

- **Status:** fixed
- **Fixed in branch:** `fix/issue-387-sec020-email-verified-jit`
- **Date:** 2026-06-12

### Changes

- `apps/api/src/auth/jwt-auth.guard.ts` — In `jitProvision`, derive `emailVerified` from
  `profile['email_verified']` (accepts `true` or `'true'`). Inside the `emailOwner` block, on the
  `externalId IS NULL` claimable branch, throw `ForbiddenException` when `emailVerified` is not true
  — before any `updateMany` call. The fresh-create path (no `emailOwner`) is unchanged, as a brand-new
  self-owned row never inherits anyone's role and gating it would lock out legitimate BYOI users.
- `apps/api/src/auth/jwt-auth.guard.spec.ts` — Added four SEC-020 tests:
  - unverified (`email_verified: false`) does NOT claim + throws `ForbiddenException` (regression guard).
  - absent `email_verified` does NOT claim + throws `ForbiddenException`.
  - verified (`email_verified: true`) still claims and inherits role (over-correction guard).
  - verified as string `'true'` is accepted (IdP compat).
  - Updated two pre-existing account-linking tests to include `email_verified: true` so they reflect
    the correct real-world scenario (a verified-email operator linking the seeded ADMIN).

### Verification

- `grep -n "email_verified" apps/api/src/auth/jwt-auth.guard.ts` → line 430 (≥1 match).
- `cd apps/api && bun test src/auth/jwt-auth.guard.spec.ts` → 35 pass, 0 fail (including all new tests).
- `bunx tsc --noEmit -p apps/api/tsconfig.json` → exit 0.

### Residual risk

The BYOI pre-condition (every app-created user has `externalId = null`, `users.service.ts:164-175`) is
unchanged — it is the linking *surface*, not the bug. The verified-email gate is what makes that surface
safe. A future SSO config UI could expose the `emailVerified` derivation as a toggle; keep
`=== true || === 'true'` as the single source of truth.
