---
id: SEC-079
title: next-auth 5.0.0-beta.31 advisories — a config error makes the web's `!session` guards fail open (UI only)
severity: low
status: fixed
cwe: CWE-636
discovered: 2026-09-24
module: web-auth (dependency)
tags: [dependency, auth, fail-open, frontend]
---

# SEC-079 — next-auth beta.31 advisories: `!session` guards fail open on a config error

## Summary

`bun audit` flags `next-auth ^5.0.0-beta.31` (via `@auth/core 0.41.2`) in `apps/web` for four Auth.js
advisories. One of them applies to lazyit: under a server-side Auth.js configuration error, `auth()`
returns a truthy error object, and the web's `if (!session)` guards let an anonymous visitor into the
app shell. The API still denies every data request. The other three do not apply. All four are fixed in
`next-auth@5.0.0-beta.32` / `@auth/core@0.41.3`. Tracked in #1399.

## Description

| Advisory | Upstream | lazyit | Why |
| --- | --- | --- | --- |
| GHSA-8fpg-xm3f-6cx3: config errors make existence-based checks fail open | Critical | **Partially (UI only)** | See below. |
| GHSA-7rqj-j65f-68wh: email normalizer homoglyph `@` bypass | Critical | No | It affects only the Email/magic-link provider. lazyit registers Credentials and, optionally, one generic OIDC provider (`apps/web/auth.ts`). |
| GHSA-xmf8-cvqr-rfgj: `getToken()` throws on a malformed Bearer | High | No | lazyit never calls `getToken()`. It uses only `auth()`, which the advisory lists as unaffected. |
| GHSA-x445-f3h2-j279: OAuth check cookies not bound to their provider | Moderate | No | It needs several OAuth/OIDC providers plus account linking while signed in. lazyit has at most one OAuth provider, and there is no adapter (JWT strategy), so accounts cannot be linked. |

**GHSA-8fpg in lazyit.** When `@auth/core`'s `assertConfig` rejects the configuration (for example a
missing `AUTH_SECRET`, or an untrusted host), the session endpoint answers `500` with
`{ message: "There was a problem with the server configuration…" }`. Through beta.31, next-auth's
`auth()` wrapper parsed that body as the session, in both the middleware and Server Component paths.
lazyit's guards checked only existence:

- `apps/web/proxy.ts`: `if (!session)` gates route protection and the first-run check.
- `apps/web/app/(app)/layout.tsx`, `app/(print)/layout.tsx`, `app/change-password/layout.tsx`: `if (!session) redirect("/login")`.
- `apps/web/app/(auth)/login/page.tsx`: `(await auth())` bounces a "signed-in" visitor.
- `apps/web/app/layout.tsx`: the `auth()` result seeds `<SessionProvider>`, so the client read as `authenticated`.

## Impact

Low for lazyit. The only exploitable advisory is exploitable only in the UI:

- It needs an **operator misconfiguration** that already breaks sign-in for everyone. An attacker cannot
  trigger it.
- The error object carries **no `accessToken`**. The API authenticates every request on its own Bearer
  (global `JwtAuthGuard` `APP_GUARD`, deny by default, `@Public()` only on the setup, health, config
  and OAuth metadata surfaces). Every server prefetch and client query therefore returns 401, and **no
  domain data is served**. The visitor sees the empty app shell (navigation and static labels).
- The OAuth consent page (`/oauth/authorize`) already required `session?.accessToken`, so it was not affected.

## Proof of concept

Reasoned from the code and the public advisory, **not executed**. Install next-auth beta.31 with an
Auth.js configuration that fails `assertConfig`, then request a protected route without a cookie. The
proxy's `!session` check is false, so the request passes and `(app)/layout.tsx` renders the shell. Data
calls from the page return 401 from the API.

## Affected

At `origin/dev` c4d32c27.

- `apps/web/package.json:37`: `"next-auth": "^5.0.0-beta.31"` (lockfile resolves `@auth/core 0.41.2`).
- `apps/web/proxy.ts:100`, `apps/web/app/(app)/layout.tsx:27`, `apps/web/app/(print)/layout.tsx:22`,
  `apps/web/app/change-password/layout.tsx:25`, `apps/web/app/(auth)/login/page.tsx:101`,
  `apps/web/app/layout.tsx:58`: existence-only session checks.

## Recommendation

Upgrade to `next-auth@5.0.0-beta.32`. It returns `null` for any non-OK session response, validates the
Bearer decode, binds check cookies to their provider, and applies NFKC before validating an email.
Independently, test for a concrete session field (`session.user`) rather than truthiness. This is the
advisory's own workaround.

## Prevention

Every server-side session guard goes through `hasSession()` (`apps/web/lib/auth/has-session.ts`), never
a bare `if (!session)`. ADR-0039 §5 records the rule. Treat `[auth][error]` log lines as a failed
deployment. The API remains the authorization boundary. The web guards protect only the UI.

## References

- GHSA-8fpg-xm3f-6cx3, GHSA-7rqj-j65f-68wh, GHSA-xmf8-cvqr-rfgj, GHSA-x445-f3h2-j279
- CWE-636 (Not Failing Securely)
- [[0039-authjs-v5-frontend-oidc]] · #1399

## Resolution

**Status**: fixed
**Fixed in**: commits `f4f11843` (`fix(web): upgrade next-auth to 5.0.0-beta.32 for Auth.js advisories (#1399)`) and `50abf33f` (`fix(web): require a real session user in server-side auth guards (#1399)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-09-24

### Changes
- `apps/web/package.json`, `bun.lock`: `next-auth` `5.0.0-beta.31 → 5.0.0-beta.32` (`@auth/core 0.41.2 → 0.41.3`). No other package moved.
- `apps/web/lib/auth/has-session.ts`: new `hasSession()` guard. It requires an object `session.user`.
- `apps/web/proxy.ts`, `app/(app)/layout.tsx`, `app/(print)/layout.tsx`, `app/change-password/layout.tsx`, `app/(auth)/login/page.tsx`: guard with `hasSession()`.
- `apps/web/app/layout.tsx`: seed `<SessionProvider>` only with a real session.
- `docs/03-decisions/0039-authjs-v5-frontend-oidc.md`: version bump and the guard rule.

### Tests added
- `apps/web/lib/auth/has-session.test.ts`::"the Auth.js configuration-error body is not a session". The test asserts that the error body is truthy, which a `!session` guard would accept, and that `hasSession()` rejects it.

### Verification
- The installed `next-auth@5.0.0-beta.32` `lib/index.js` routes every `getSession()` result through `parseSessionResponse`, which returns `null` when `!response.ok`. `@auth/core@0.41.3` `jwt.js` wraps `decodeURIComponent` in a try/catch, and `oauth/checks.js` stores and verifies `provider` in each check cookie.
- `bun install --frozen-lockfile`, shared build, `tsc -p apps/web`, `apps/web` `bun test` (1413 pass), scoped eslint and `bun run --filter @lazyit/web build` all pass.

### Residual risk
None from these advisories. Upgrade note: the session cookie (JWT) format is unchanged, so signed-in users stay signed in. An OIDC sign-in that is **in progress** during the upgrade fails its callback once, because the old check cookie has no provider binding. The user signs in again.
