---
id: SEC-009
title: Swagger /api/docs + /api/docs-json reachable by an unauthenticated caller on the public origin
severity: low
status: fixed
cwe: CWE-200
discovered: 2026-06-02
module: transversal
tags: [exposure, info-leak, hardening, swagger, infra]
---

# SEC-009 — Swagger docs are the one anonymous surface enumerating the full authenticated API

## Summary

`GET /api/docs` (Swagger UI) and `GET /api/docs-json` (raw OpenAPI) are served with no guard and were
forwarded to the public origin by Caddy. Now that every non-`@Public()` route requires a Bearer JWT
([[0038-jit-user-provisioning]], DEF-001 resolved), the OpenAPI document is the single anonymous
surface that enumerates the **entire authenticated attack surface** (every path, param, schema).

## Description

Two layers exposed the docs anonymously:

1. **App** — `apps/api/src/main.ts` mounts `SwaggerModule.setup('api/docs', app, document)` with no
   condition and no guard. Swagger registers its routes directly on the Express adapter, **outside**
   the Nest guard chain, so the global `JwtAuthGuard` never sees `/api/docs*` — the docs are reachable
   without a token regardless of how locked-down the rest of the API is.
2. **Infra** — `infra/caddy/Caddyfile` had an explicit `@apidocs path /api/docs*` handle that
   `reverse_proxy api:3001` on the **public** site block, so the docs were reachable from the internet
   (or LAN), not just the internal Docker network.

This was consciously accepted as **DEF-003** because the whole API was unauthenticated and dev-only
(consistent with DEF-001). That rationale is now **stale**: DEF-001 is resolved — authentication
(`JwtAuthGuard`) and RBAC (`RolesGuard`) are live — so the docs are no longer "just describing an open
API". They hand an anonymous attacker a complete, machine-readable map of every guarded endpoint.

## Impact

Low, and information-disclosure only (no direct authz bypass): the docs do not grant access, they
*describe* it. But the value of an enumerated attack surface to an attacker is real — it removes the
discovery step for every endpoint, param shape and error contract before they even obtain a token.
Belt-and-suspenders hardening: stop serving it in production at all, and stop proxying it publicly.

## Proof of concept

Reasoned from the code + Caddyfile, **not executed** (the stack is not run during review). Against a
deployment built before this fix:

```sh
curl -sk https://<site>/api/docs-json | jq '.paths | keys'   # full path list, no auth
curl -sk https://<site>/api/docs                              # Swagger UI, no auth
```

## Affected

- `apps/api/src/main.ts` — `SwaggerModule.setup('api/docs', …)` mounted unconditionally.
- `infra/caddy/Caddyfile` — the public `@apidocs path /api/docs*` → `reverse_proxy api:3001` handle.

## Recommendation

Belt-and-suspenders, no new dependency:

1. **App (belt):** only mount Swagger when `NODE_ENV !== 'production'`, so a prod server does not serve
   the docs at all. Dev DX is unchanged (docs still work locally, where `NODE_ENV` is not `production`).
2. **Infra (suspenders):** remove the public `@apidocs` forward so `/api/docs*` is not proxied to the
   public origin. With the handle gone, `/api/docs*` falls to the `@api` matcher, which strips `/api`
   → `/docs*`; the API serves Swagger at `/api/docs` (unstripped), so `/docs*` is a 404 — never a docs
   page. The docs remain reachable on the internal Docker network and in local dev.

## Prevention

Make "no doc/introspection surface is mounted on a prod build or proxied to the public origin" a review
rule. Tie the gate to `NODE_ENV` (already the logging/auth posture switch) rather than a new flag, so
there is one production signal. Revisit DEF-003 in `deferred.md` whenever the auth posture changes.

## References

- CWE-200: Exposure of Sensitive Information to an Unauthorized Actor.
- [[0018-api-documentation-swagger]] (Swagger decision) · [[0038-jit-user-provisioning]] (auth landed,
  DEF-001 resolved) · DEF-003 in `docs/06-security/deferred.md` (now updated to record this resolution).

## Resolution

**Status**: fixed
**Fixed in**: commit `<main.ts>` (`fix: gate Swagger behind NODE_ENV !== production (SEC-009)`) +
commit `<Caddyfile>` (`fix: stop proxying /api/docs* on the public origin + trusted_proxies [CTO-authorized infra]`)
**Fixed by**: lazyit-remediator
**Date**: 2026-06-02

### Changes

- `apps/api/src/main.ts`: the entire `DocumentBuilder` + `SwaggerModule.createDocument` +
  `SwaggerModule.setup('api/docs', …)` block now runs **only** when `process.env.NODE_ENV !==
  'production'`. A production container (which sets `NODE_ENV=production`) does not register the docs
  routes at all; dev/local (where `NODE_ENV` is unset or non-production) is unchanged.
- `infra/caddy/Caddyfile` *(CTO-authorized cross-lane infra edit)*: removed the public
  `@apidocs path /api/docs*` → `reverse_proxy api:3001` handle. A public `/api/docs*` now falls to the
  `@api` matcher (strips `/api` → `/docs*`, which the API does not serve → 404), so no Swagger page is
  served on the public origin. A comment documents the intentional absence.

### Tests added

- None directly: the change is a boot-time mount condition + a proxy route removal, both
  configuration rather than request-handling logic. Covered by the verification below; the existing
  api suite (700 tests) confirms no regression in the guarded routes. The companion SEC-010 fix in the
  same PR adds the request-level test.

### Verification

- Strict typecheck `bunx tsc -p apps/api/tsconfig.json --noEmit` clean (the gated block compiles).
- `apps/api` jest: 57 suites / 700 tests pass (no route behaviour regressed).
- `apps/api` `nest build` green.
- Caddyfile change is doc-verified against the Caddy reverse_proxy/handle semantics (the `caddy`
  binary is not present in the review sandbox to run `caddy adapt`). With `@apidocs` removed,
  `/api/docs*` matches `@api` (path `/api/*`, not `/api/auth/*`) → `strip_prefix /api` → `/docs*` to
  `api:3001`, which the API does not route (Swagger is at `/api/docs`, unstripped) → 404.

### Residual risk

The docs are still reachable **on the internal Docker network** (and in local dev) — by design, for
operators and developers. There is no auth on that internal surface; that is acceptable under the
self-hosted, internal-network posture (anyone on the internal network already has privileged
positioning). DEF-003 in `deferred.md` is updated to reflect that the public exposure is closed and
only the deliberate internal/dev reachability remains.
