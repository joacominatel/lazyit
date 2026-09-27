---
id: SEC-082
title: The `lazyit.admin` consent step-up is a password oracle with no per-account backoff and no audit of failures
severity: low
status: closed
cwe: CWE-307
discovered: 2026-09-25
module: oauth
tags: [oauth, step-up, brute-force, password]
---

# SEC-082 — OAuth consent step-up lacks the login and chat step-up backoff

## Summary

`POST /oauth/authorize/decision` checks the user's password when `lazyit.admin` is granted. The only
throttle is a fixed 10-per-minute window per user, with no exponential lockout, and failures are neither
audited nor logged. A holder of a stolen session token (not the password) gets about 14,400 guesses per
day per replica, far more than the login path or the chat approval step-up allow.

## Description

- `AuthorizationService.requireStepUp` calls `LocalCredentialService.verify` directly
  (`apps/api/src/oauth/authorization.service.ts:203-229`, verify at `:221`). A wrong password is a
  `403 STEP_UP_FAILED`. Nothing is recorded, and no backoff state changes.
- The only bound is `ConsentDecisionRateLimitGuard` (`apps/api/src/oauth/oauth-rate-limit.ts:108-121`),
  `CONSENT_DECISION_RATE_LIMIT = { max: 10, windowMs: 60_000 }`
  (`apps/api/src/oauth/oauth.constants.ts:54`). It is in memory, per replica, and resets every minute.
- The chat approval step-up (`apps/api/src/ai/runtime/step-up.verifier.ts:53-118`) follows the
  ADR-0086 §3 login policy: one attempt in flight, 5 free failures, then an exponential lock up to 15
  minutes, and a warn log on each failure (`approval.service.ts:233-250`). The login flow has its own
  per-account backoff. The consent step-up has neither, and the three counters are independent, so
  locking one does not slow the others.

Each attempt needs a valid authorization request: an allowlisted client, for example the bundled Claude
Code CIMD entry with a loopback redirect, which any `ai:connect` user can build. A failed attempt writes
nothing, so attempts can repeat indefinitely.

## Impact

An attacker who has a user's web session Bearer (XSS, a leaked token, a shared workstation) but not the
password can brute-force the password through the consent endpoint. Once they have the password, they can
sign in again after the session is revoked, pass every chat step-up (privilege grants, credential
delivery, critical applications), grant `lazyit.admin` to a client they control, and change the
password. Mitigations: a stolen session is required, argon2id makes each guess costly, the target must
hold `ai:connect` on an HTTPS instance with MCP enabled, and `AUTH_MODE=local` must be in use (elsewhere
the step-up is unavailable). Hence Low.

## Proof of concept

Reasoned from the code, not executed.

```
for pw in wordlist:                       # 10 per minute, per replica
  POST /oauth/authorize/decision
  Authorization: Bearer <stolen session JWT>
  { "decision": "approve", "scopes": ["lazyit.admin"], "password": pw,
    "params": { "client_id": "<allowlisted client>", "redirect_uri": "http://127.0.0.1:33418/callback",
                "response_type": "code", "code_challenge": "<S256>", "code_challenge_method": "S256",
                "scope": "lazyit.admin" } }
  # 403 STEP_UP_FAILED → wrong; 200 { redirectTo } → password found
```

## Affected

- `apps/api/src/oauth/authorization.service.ts:203-229`
- `apps/api/src/oauth/oauth-rate-limit.ts:108-121`, `apps/api/src/oauth/oauth.constants.ts:54`

## Recommendation

Route the consent step-up through the same verifier as the chat. Move `AiStepUpVerifier` (or a shared
`PasswordStepUpService`) to `auth/local` and use it in both places, so one per-account backoff covers the
chat approvals and the consent, and ideally the login backoff too. Log each `STEP_UP_FAILED` and each
lock, and add an `OAuthAuditService` event for a failed admin-scope step-up.

## Prevention

Keep one password step-up primitive for the whole app, and add a test that fails if any caller other than
the login service and that primitive calls `LocalCredentialService.verify`.

## References

- CWE-307; OWASP ASVS V2.2 (anti-automation).
- ADR-0086 §3 (login backoff); `docs/ai-assistant/security.md` §6.3, G3 "Abuse".

## Resolution

**Status**: fixed
**Fixed in**: commits `df4bcbfc` (`fix(api): make the password step-up verifier one shared auth primitive (SEC-082)`) and `82b7f847` (`fix(api): consent admin step-up uses the shared backoff and audits failures (SEC-082)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-09-25

### Changes
- `apps/api/src/auth/local/password-step-up.verifier.ts` (moved from `ai/runtime/step-up.verifier.ts`): `PasswordStepUpVerifier`, the one step-up primitive. The policy is unchanged: one verification in flight per user, 5 free failures, then an exponential lock from 1 s to 15 min. The constants moved with it from `runtime.constants.ts`.
- `apps/api/src/auth/auth.module.ts`: the global `AuthModule` provides and exports it, and `AiRuntimeModule` no longer provides its own copy. The chat approvals and the consent therefore inject the same instance and share one per-account counter.
- `apps/api/src/oauth/authorization.service.ts`: `requireStepUp` calls the verifier instead of `LocalCredentialService.verify`. A lock answers 429 `STEP_UP_RATE_LIMITED` with `retryAfterSec`, the same as the chat. The web consent page already maps a 429 to "rate-limited". Each refused attempt writes a warn log and an `OAuthAuditService` row, `CONSENT_STEP_UP_FAILED`, with `detail.reason` set to `invalid` or `locked`. Neither records the password.
- `packages/shared/src/schemas/oauth.ts`: `OAUTH_AUDIT_ACTIONS` gains `CONSENT_STEP_UP_FAILED`. This is an additive contract change. The column is a `String`, so no migration is needed.
- The docs in `docs/ai-assistant/{mcp-and-oauth,security,provider-and-runtime}.md` and the Manual page `ai-assistant-claude-code-mcp` (en and es) are updated.

### Tests added
- `apps/api/src/oauth/oauth-flow.spec.ts`::"locks the account after repeated wrong passwords — even the right one is refused (SEC-082)". It fails without the fix because the seventh attempt, with the right password, returned a code.
- `…`::"shares one backoff with the chat approvals: a lock earned there refuses the consent (SEC-082)". It fails without the fix because the consent had no link to the chat counter.
- `…`::"audits every failed or locked step-up, never the password (SEC-082)". It fails without the fix because no audit row was written.
- `apps/api/src/auth/local/password-verify-callers.spec.ts`: the Prevention test. Only the login, the password change and the step-up primitive may call `LocalCredentialService.verify`. It failed on `oauth/authorization.service.ts` before the fix.
- `apps/api/src/ai/runtime/ai-runtime.module.spec.ts`: the approval service must receive the global verifier instance, not a module-local one.

### Verification
All five tests fail on `origin/dev` f70ab76f and pass with the fix. The full API Jest suite passes (5864, under Node). `tsc` passes for shared, api, web and agent. The shared, web and agent `bun test` suites pass, and scoped eslint is clean.

### Residual risk
The login flow (`LoginService`) keeps its own per-account backoff map, so a lock on the step-up surfaces does not slow the login, and the reverse is also true. Both counters are ADR-0086 §3-bounded. Merging them would change the login service and is outside this Low finding. Like the login backoff, the counters are in memory and per replica.
