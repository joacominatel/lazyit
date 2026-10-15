---
id: SEC-012
title: OIDC token audience is not validated when OIDC_CLIENT_ID is unset (token-audience confusion on a shared issuer)
severity: low
status: open
cwe: CWE-287
discovered: 2026-06-06
module: auth (identity / jwt-auth.guard)
tags: [authn, oidc, audience, byoi, hardening]
---

# SEC-012 — OIDC audience validation is optional; absent OIDC_CLIENT_ID accepts any token from the issuer

## Summary

`JwtAuthGuard` only validates the token `aud` when `OIDC_CLIENT_ID` is set; `OIDC_CLIENT_ID` is
optional at boot, so a deployment can run accepting ANY RS256 JWT validly signed by the issuer's JWKS
with a `sub` — including a token minted for a different relying party on the same OIDC issuer.

## Description

In OIDC mode the guard verifies the bearer with `jose.jwtVerify`, pinning the issuer and RS256, but
applies audience validation conditionally:

```ts
...(process.env.OIDC_CLIENT_ID
  ? { audience: process.env.OIDC_CLIENT_ID }
  : {}),
```
(`apps/api/src/auth/jwt-auth.guard.ts:405-409`).

The boot contract requires `OIDC_ISSUER` + `OIDC_JWKS_URI` in OIDC mode but leaves `OIDC_CLIENT_ID`
optional (`apps/api/src/auth/boot-config.ts:63`, no `.refine` requires it). When it is unset, the guard
accepts any token that (a) is signed by a key in the issuer's JWKS and (b) carries a `sub` — the `aud`
claim is never checked. On an OIDC issuer that serves more than one client/relying party (a realistic
BYOI case: one Keycloak/Authentik/Zitadel instance fronting several apps), a token issued for *another*
app is signed by the same JWKS and therefore passes here. lazyit then JIT-resolves / authenticates that
token's `sub` as a lazyit user.

The comment explains the optionality: some IdPs issue access tokens whose `aud` is a resource or API
identifier rather than the client id, so pinning `OIDC_CLIENT_ID` could reject valid tokens. That is a
legitimate OAuth subtlety, but the result is that the safe default (validate audience) is silently
disabled rather than replaced with a correct audience check, and nothing warns the operator that
audience validation is off.

## Impact

Token-audience confusion / cross-app token replay on a shared issuer: a token obtained for a different
(possibly lower-trust) relying party on the same IdP can be presented to lazyit and authenticates as
that user. It is not a privilege escalation by itself (the caller still authenticates as a legitimate
IdP identity, and authorization stays DB-first), but it widens lazyit's authentication surface to every
client of the shared issuer and enables a confused-deputy: a user who only ever logged into "app B"
can have their token replayed against lazyit.

Mitigating context: the guided BYOI install asks for the client id and writes `OIDC_CLIENT_ID`
(`infra/start.sh:1177`, `:525`), and the `/setup` environment snippet lists it
(`apps/web/app/setup/_components/byoi-snippet.tsx:19`), so an instance configured either way validates
the audience. The exposure is an instance whose `.env.prod` was written by hand without it, on an issuer
shared with other apps — hence **Low**. Before [[0102-remove-bundled-zitadel|ADR-0102]] the bundled
single-app Zitadel was a further mitigation; it no longer ships, so every OIDC instance is now BYOI.

## Proof of concept

Reasoned, **not executed** (no IdP/API is run during review). With `AUTH_MODE` OIDC, `OIDC_ISSUER` set,
`OIDC_CLIENT_ID` unset, and a second client `appB` registered on the same issuer:

1. Obtain a valid access/JWT token for `appB` (its `aud` = `appB`, signed by the issuer JWKS).
2. Call any non-`@Public` lazyit route with `Authorization: Bearer <appB-token>`.
3. `jwtVerify` passes (issuer + RS256 match, no audience constraint); the guard authenticates the
   token's `sub` against lazyit's DB (JIT-provisioning it if new).

## Affected

- `apps/api/src/auth/jwt-auth.guard.ts:289-292` — audience validated only when `OIDC_CLIENT_ID` is set.
- `apps/api/src/auth/boot-config.ts:32` — `OIDC_CLIENT_ID` is optional in OIDC mode (no `.refine`).

## Recommendation

- Validate audience by default in OIDC mode. Document the expected audience for the common IdPs (some
  put a resource or project identifier in the access token's `aud` rather than the client id) and
  require it via env (e.g. `OIDC_AUDIENCE`), falling back to `OIDC_CLIENT_ID` for ID-token style
  audiences.
- If audience validation genuinely cannot be enforced for a given IdP, emit a loud boot WARN that
  audience validation is DISABLED, so the operator makes an informed choice rather than inheriting an
  insecure default silently.
- Document the trade-off in ADR-0102 §2 or ADR-0038 (verify against `jose` / RFC 9068 "JWT access
  tokens" current guidance before implementing).

## Prevention

Treat "accept any token from the issuer" as an explicit, logged opt-in, never a silent default. Add a
boot-config test asserting that OIDC mode either has an audience constraint or logs the disabled-audience
warning, and a guard test that a token with the wrong `aud` is rejected when an audience is configured.

## References

- CWE-287 (Improper Authentication), CWE-345 (Insufficient Verification of Data Authenticity).
- RFC 9068 (JWT Profile for OAuth 2.0 Access Tokens) — audience validation. OIDC Core §3.1.3.7
  (ID Token audience validation).
- [[0102-remove-bundled-zitadel|ADR-0102]] (generic OIDC by environment variables, which superseded
  ADR-0037) · ADR-0038 (JIT provisioning) · `docs/06-security/INVARIANTS.md` INV-1.

## Triage note

Re-verified 2026-10-09 on the epic #1543 integration branch (`340645acb`) after the bundled Zitadel was
removed. The finding still holds: the guard and the boot contract are unchanged apart from line numbers.
It stays open at **Low**. The references, the mitigating context and the Zitadel-specific
recommendation were updated to the BYOI-only posture.
