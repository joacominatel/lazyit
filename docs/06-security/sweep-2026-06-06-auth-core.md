---
title: Sweep 2026-06-06 — auth core (authN / authZ / service accounts / first-run)
tags: [security, sweep, auth, authz, service-accounts, config]
status: draft
created: 2026-06-06
updated: 2026-06-06
---

# Sweep 2026-06-06 — security-critical auth core

Adversarial review of the authN/authZ core + its integration with the rest of the system. Method:
`.claude/skills/lazyit-sentinel/SKILL.md`. Measured against `INVARIANTS.md` (INV-1..8, INV-SA-1..4) and
ADR-0037/0038/0040/0041/0043/0046/0047/0048. The API was **not run** — all PoCs are reasoned, not
executed.

## Scope (reviewed end-to-end)

- **`apps/api/src/auth` + `auth/identity`** — `JwtAuthGuard` (SA branch, shim, OIDC JIT, email-linking,
  userinfo/discovery enrichment), `RolesGuard` (human open-by-default vs SA fail-closed),
  `PermissionResolverService`, `require-permission` / `public` / `current-principal` / `current-user`
  decorators, `principal.ts`, `boot-config.ts`, `bootstrap-file.ts`, `auth.module.ts`,
  identity-provider interface/factory, `generic-oidc` + `zitadel-management` providers.
- **`apps/api/src/config`** — first-run `setup()` + the public `status`/`csrf` surface, `SetupCsrfService`
  (stateless HMAC double-submit), `SetupRateLimitGuard`, `PermissionsConfigService`
  (`GET/PUT /config/permissions`, `my-permissions`), `integration-mode.ts`, `ConfigController`.
- **`apps/api/src/service-accounts`** — token mint/parse/hash/verify, permission resolution,
  `ServiceAccountsService` (create/update/rotate/revoke/restore + audit), controller.
- **Integration** — `main.ts` (CORS, trust-proxy, Swagger gating), the Prisma soft-delete extension +
  the `ServiceAccount` / `RolePermission` / `*AuditLog` schema, and the users-module last-admin guard
  (because first-run `setup()` reopens iff live `adminCount == 0`).

## Findings filed (SEC-011..SEC-012)

| ID | Severity | Title |
| --- | --- | --- |
| [[SEC-011-service-account-coarse-meta-permission-escalation\|SEC-011]] | 🟠 Medium | A service account can hold `settings:manage` / `user:manage` → ADMIN-equivalent self-escalation + persistence (diverges from INV-SA-3) |
| [[SEC-012-oidc-audience-not-validated\|SEC-012]] | 🟡 Low | OIDC token audience not validated when `OIDC_CLIENT_ID` unset (token-audience confusion on a shared issuer) |

No Critical found. SEC-011 is the one to weigh: it is rated Medium because it requires an ADMIN to grant
the coarse verb, but the escalation once granted is severe (self-grant the full catalog, mint backdoor
SAs, rewrite the human MEMBER/VIEWER matrix) and could be argued High in any deploy that uses
`settings:manage`/`user:manage` service accounts.

> Not re-filed: the `email_verified` JIT-link gap is already
> [[SEC-020-jit-email-link-no-email-verified\|SEC-020]] (filed by a parallel agent, same root cause I
> independently reached — High under BYOI). The last-admin `isActive` lockout is
> [[SEC-021-last-admin-lockout-via-isactive\|SEC-021]]. Both overlap this scope and are correct.

## Verified CLEAN (invariants upheld)

- **INV-1 / INV-8 — DB-first authZ.** `RolesGuard` resolves humans from `RolePermission` rows for
  `request.user.role` (DB-set by `JwtAuthGuard`), never a token claim; ADMIN short-circuits to the full
  catalog without a DB read; catalog-foreign rows are ignored; an empty seed fails CLOSED.
- **INV-SA-1 — SA token verification.** DB-first lookup by id INCLUDING soft-deleted (so revoked is
  *seen*), constant-time `timingSafeEqual` SHA-256 compare done BEFORE the revoked/inactive/expired
  branches, all rejections a generic 401. `parseToken` rejects malformed/empty id|secret. Secret never
  logged; only the SHA-256 hash + non-secret `tokenPrefix` persisted; cleartext shown once.
- **INV-SA-2 — SA fail-closed.** A service principal on an unannotated / `@RequirePermission()`-no-args
  route is 403 (incl. `GET /config/my-permissions`), never the human open-by-default.
- **INV-SA-4 — honest attribution.** Audit writes use `@CurrentPrincipal` → human XOR SA column; SA
  self-management is recorded `actorId = null` (honest, acknowledged gap #141 — flagged in SEC-011).
- **INV-2 — email linking** (mechanics): claims only `externalId IS NULL` LIVE rows, never re-binds a
  row already bound to a different `sub` (409), soft-delete-filtered so an offboarded email is never
  resurrected, race-safe `updateMany`. (The missing `email_verified` premise is SEC-020.)
- **INV-3 — first-run setup.** `setup()` 409s the instant a live ADMIN exists; CSRF checked before any
  DB work (stateless HMAC, constant-time compare, 30-min TTL); per-IP rate-limit on the verified
  `req.ip` (SEC-010); every admin creation audited. CSRF is sound: the token is unreadable cross-origin
  (CORS) and the `X-CSRF-Token` header forces a preflight restricted to `WEB_ORIGIN`.
- **INV-4 / INV-5 — write-back posture.** Management never on the authN path; `generic-oidc` no-ops with
  a warn (`requestPasswordReset` correctly 501s, not a silent 2xx); `ZitadelManagementService` ctor
  never throws, missing creds warn; the bounded retry (≤3, ~1.8s, `Retry-After`, non-idempotent
  POSTs single-shot) does not relax the revert-and-503 model.
- **INV-6 — secrets.** SA key read from a mounted file/inline env, never logged; the management 503
  message is generic (no verb/path/status leak); CSRF signing key never logged.
- **INV-7 — first/last ADMIN.** First-ever JIT user = ADMIN (`userCount === 0`, counting soft-deleted),
  later JIT = VIEWER; `setup()` locks role to ADMIN (`SetupAdminSchema` is `strictObject`, no `role`);
  `assertNotLastAdmin` guards role-demote + offboard/delete + self-role-change. (The `isActive` bypass
  of that guard is SEC-021.)
- **Mass assignment.** `CreateServiceAccountSchema` / `UpdateServiceAccountSchema` / `SetupAdminSchema` /
  `UpdateRolePermissionsSchema` are `strictObject`/`.strict()`; server-owned fields (`tokenHash`,
  `tokenPrefix`, `createdById`, `id`, `externalId`, `role`) are never accepted from the body; SA secret
  is server-minted only; `expiresAt` rejects a past instant.
- **Soft-delete consistency.** `ServiceAccount` is soft-delete-filtered; the guard + `restore` use the
  `includeSoftDeleted` escape hatch deliberately so a revoked token is rejected, not missed.
- **Cheap class re-grep (clean today).** No `$queryRaw`/`$executeRaw` (no SQLi), no
  `child_process`/`exec`/`eval` (no command injection), no `fs` writes from request input in these
  modules, no secret logging. RS256 pinned in `jwtVerify` (no alg-confusion / `none`). `AUTH_MODE=shim`
  refused under `NODE_ENV=production` (boot-config). Swagger mounted only when `NODE_ENV !== production`.

## Integration risks / notes (not filed)

- **First-run reopen coupling.** `setup()` / `getStatus` derive "configured" from live `adminCount > 0`.
  If `adminCount` ever reaches 0 the PUBLIC setup endpoint reopens (anyone can create the first ADMIN,
  rate-limited + CSRF + audited). The last-admin guard keeps `adminCount > 0` for demote/offboard/delete,
  **but** (a) the accepted two-concurrent-demotions race (ADR-0040) and (b) the `isActive` bypass
  (SEC-021) can both drive it to 0 — at which point the consequence is not just an un-administrable UI
  but a re-openable public bootstrap. Worth keeping in mind when triaging SEC-021.
- **PermissionResolverService cache has no TTL.** MEMBER/VIEWER sets are cached in-process and only
  dropped by `invalidate()` on the instance that handles `PUT /config/permissions`. Correct for the
  documented single-instance deployment; under a future multi-replica deploy a revoked permission would
  stay effective (stale-allow) on the other replicas until restart. Latent (matches the single-instance
  posture the `SetupRateLimitGuard` also assumes); not a finding today.
- **SA `lastUsedAt` write on every authenticated request.** Fire-and-forget, swallowed on failure; a
  per-request DB write but bounded by request rate — noted, not a finding.
- **SA-id timing.** Lookup-then-compare means an existing SA id does one extra SHA-256 + buffer compare
  vs a non-existent id; the delta is sub-millisecond and the id is a non-secret cuid embedded in the
  token — not a usable enumeration oracle.

## Coverage gaps (self-assessment)

- No dynamic testing (API not run); the `nestjs-zod` global-pipe boundary and the exact `jose`
  audience/clock behavior were reasoned from code, not exercised.
- `mammoth` / `jose` / Zitadel internals are out of scope (dependency phase).
- Frontend (`apps/web`) — the `/settings/service-accounts` and `/setup` UIs and the render sink for any
  stored content — remains out of scope.

Related: [[INVARIANTS]] · [[deferred]] · [[SEC-011-service-account-coarse-meta-permission-escalation]] ·
[[SEC-012-oidc-audience-not-validated]] · [[SEC-020-jit-email-link-no-email-verified]] ·
[[SEC-021-last-admin-lockout-via-isactive]] · ADR-0043 · ADR-0046 · ADR-0048
