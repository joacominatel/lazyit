---
title: Security invariants (auth / authZ)
tags: [security, invariants, auth, authz, oidc, rbac, zitadel, ai-assistant, mcp, oauth]
status: accepted
created: 2026-06-01
updated: 2026-09-26
---

# Security invariants — auth & authorization

The **non-negotiables** of the lazyit auth stack, distilled from
[[0043-zitadel-source-of-truth]] §6 (the CEO-approved conditions of acceptance) and the design
dossier [[auth-zitadel-sot]] §6. These are not findings or open issues — they are the *baseline a
finding is measured against*. If code diverges from any of them, that divergence is a `SEC-NNN`
([[_MOC]]); link this note from it.

> **How to use this note.** Before reviewing or changing anything on the auth/authZ path, confirm the
> change still upholds every invariant below. Each row names *where it is enforced* so a reviewer can
> read the guard, not guess. Validated live end-to-end on **2026-06-01** (the auth epic — ADR-0043 —
> is delivered; the as-built hardening is recorded in the ADR's "Validated live" note).
>
> **AI assistant, MCP and OAuth.** INV-AI-1…17 (and the INV-MCP-1…7 mapping) are the last section,
> [[#AI assistant, MCP and OAuth invariants (ADR-0097)]]. They joined on 2026-09-26 (#1315, W4-4).

---

## INV-1 — Authorization is DB-first; a token role claim is NEVER an authZ source

**Rule.** Every privilege decision reads `User.role` from the **local database**. A role claim in the
OIDC token is informational/provenance only and never gates access. A claim-vs-DB mismatch (if a claim
is ever surfaced) is logged at `warn`, never trusted.

**Why.** A forged or misconfigured token must not be able to escalate; this keeps authZ vendor-neutral
and BYOI-safe (a generic IdP need not emit a role claim at all).

**Where enforced.**
- `apps/api/src/auth/roles.guard.ts` — `RolesGuard` reads `request.user.role` (the DB row) and 403s on
  an insufficient role; it reads **no** token claim.
- `apps/api/src/auth/jwt-auth.guard.ts` — `JwtAuthGuard` resolves `request.user` from the DB by
  `externalId` (the `sub`); the role on a JIT insert is computed from DB state
  (`userCount === 0 ? ADMIN : VIEWER`), not from any token claim.
- `apps/api/src/auth/identity/identity-provider.interface.ts` — the interface contract states the IdP
  is a *write-back mirror*, never an authorization source.

> The token-authoritative variant (read role from the claim) was **explicitly rejected** in ADR-0043
> §2 / Fork #1. There is currently **no code path that reads a role claim into `request.user.role`**, so
> the "mismatch → warn" log is a *future* guard for if/when a role claim is surfaced as provenance — not
> a present-day code path.

## INV-2 — Account-linking by email is claim-only, race-safe, never steals, and requires a verified email

**Rule.** First-login email linking claims **only** rows with `externalId IS NULL` that are **live**
(`deletedAt IS NULL`). It NEVER re-binds an email already linked to a different `sub` (returns/keeps a
409-style rejection), and soft-deleted rows are invisible — an offboarded user's email is never
resurrected by a returning `sub`. **Additionally (SEC-020, code-enforced):** linking is only permitted
when `email_verified === true` (boolean) or `=== 'true'` (string, as some IdPs emit). An unverified
email throws `ForbiddenException (403)` — no existing row is ever claimed on an unverified email, so
a BYOI attacker who self-registers with an arbitrary address cannot inherit another user's role.

**Why.** Linking is the mechanism by which a real operator inherits a seeded ADMIN row; a sloppy link
would be an account-takeover or a resurrection of an offboarded identity. The verified-email gate was
the missing third guard: the trusted-IdP assumption (ADR-0037/0038) is necessary but not sufficient —
the email itself must also be verified (OIDC Core §5.7).

**Where enforced.**
- `apps/api/src/auth/jwt-auth.guard.ts` — the link is a race-safe `updateMany` guarded by
  `externalId: null` (+ the soft-delete read filter); a row already bound to a different `sub` is not
  re-bound; `email_verified` is code-checked before any claim (SEC-020: unverified → 403,
  `updateMany` never called); and `externalId` stays **fully `@unique`** (ADR-0038/0041) so a
  returning `sub` cannot resurrect a soft-deleted row.
- `apps/api/src/auth/jwt-auth.guard.spec.ts` — tests: unverified/absent `email_verified` does NOT
  claim + throws `ForbiddenException`; verified (`true` / `'true'`) still claims (regression guard).
- Carried from [[0038-jit-user-provisioning]] / [[0041-soft-delete-reuse-and-restore]]; SEC-020 closed
  the verified-email gap; see [[deferred]] DEF-002 for the broader trusted-IdP framing.

## INV-3 — First-run setup is one-time gated, CSRF-protected, rate-limited, and audited

**Rule.** `POST /config/setup` (the public first-ADMIN bootstrap) returns **409 the instant any live
ADMIN exists** (the one-time idempotency gate), requires a valid `X-CSRF-Token`, is **rate-limited per
IP**, and **audits every admin creation**.

**Why.** It is a privileged PUBLIC pre-login surface (no session exists yet), so it must be
un-forgeable, un-brute-forceable, and self-locking.

**Where enforced.**
- `apps/api/src/config/config.service.ts` — `setup()` 409s when `user.count({ role: ADMIN }) > 0`;
  audits each creation via a structured Pino line (op/email/ip/mirrored).
- `apps/api/src/config/config.controller.ts` — rejects a missing/invalid CSRF token with 403 before any
  DB work; the setup route carries `@UseGuards(SetupRateLimitGuard)`.
- `apps/api/src/config/setup-csrf.service.ts` — stateless HMAC double-submit token.
- `apps/api/src/config/setup-rate-limit.guard.ts` — per-IP fixed-window limiter (429 over the cap).

## INV-4 — BYOI degrades gracefully; the Management API is never on the runtime authN path

**Rule.** The Zitadel Management API is used for **setup + write-back only**. It is never on the login
path. A missing or misconfigured Management credential **warns** — it never blocks login or boot. Under
`generic-oidc` (BYOI) all management methods are no-ops.

**Why.** Authentication must keep working with any standard OIDC IdP even when there is nothing to write
back to; a write-back capability outage can never lock people out.

**Where enforced.**
- `apps/api/src/auth/identity/generic-oidc.identity-provider.ts` — management methods no-op with a
  `warn` (`supportsManagement = false`). **Exception (issue #149):** `requestPasswordReset` does NOT
  silently no-op — a reset is a user-visible ACTION, so it REJECTS with `PasswordResetUnsupportedError`,
  which the Users controller maps to an honest **501** ("managed by your identity provider") rather than
  a 2xx that falsely implies a reset email was sent. `updateUser` (profile/email mirror) still no-ops.
- `apps/api/src/auth/identity/zitadel-management.service.ts` — the constructor never throws; a missing
  credential WARNs at boot-config resolution and throws "Zitadel management not configured" from the
  *management methods only*, never on the authN path.
- `apps/api/src/auth/boot-config.ts` — boot validation warns (does not fail) on an absent Management
  credential.

## INV-5 — Write-back is no-split-brain: a Management failure rolls back and surfaces 503

**Rule.** When lazyit mirrors a user/role change to Zitadel and the Management call fails, the **local
change is rolled back** (or compensated) and the request returns **503** — never a silent partial
write. Offboarding deactivates the IdP user **inside the offboard transaction**.

The mirror is **best-effort, eventually-consistent across sub-resources**, not a single atomic write:
`update`'s profile mirror is two non-atomic Zitadel v2 calls — a display-name `PUT` then a
**committed-LAST** email `POST`. The guarantees are therefore scoped:
- **The account-linking email never diverges.** It is committed LAST, so on its failure Zitadel's email
  is untouched and the local revert restores the prior address — the two agree. `externalId` (sub) is
  never changed by an edit (SEC-006), so the identity link is never at risk.
- **A mid-sequence display-name (or role) divergence is transient, not permanent.** If the name `PUT`
  commits but the email `POST` then fails, Zitadel briefly holds the NEW name while local reverts to OLD.
  The catch makes a **best-effort compensating re-mirror** of the reverted name back to Zitadel to
  converge them; if even that re-mirror fails it only LOGS (never throws over the original 503), leaving
  at worst a cosmetic display-name drift fixed by the next edit.
- **Zero authZ impact regardless.** Authorization is **DB-first** (ADR-0043 #1): permissions resolve
  from local `RolePermission` rows (INV-8), never from a Zitadel name or claim, so a stale Zitadel
  display name or role grants nothing. The divergence is cosmetic, bounded, and eventually-fixable — not
  a security hole. (We deliberately do NOT claim "local and Zitadel never disagree".)

**Why.** A soft-deleted-local / still-active-in-IdP divergence would be a real security drift, so those
roll back hard (503). The remaining cosmetic display-name/role drift is compensated best-effort because
it carries no authZ weight; failing loud on the primary write plus best-effort convergence keeps the two
stores consistent in practice without pretending a multi-call mirror is atomic.

**Where enforced.**
- `apps/api/src/users/users.service.ts` — `create` hard-deletes the just-created local row on a mirror
  failure (+503); a role change reverts the local role on a `grantRole` failure (+503); an ADMIN
  name/email edit (`update`, issue #149) mirrors `updateUser` (Zitadel v2 profile `PUT` + a PRE-VERIFIED,
  committed-LAST email `POST`, same `externalId` — no re-link, SEC-006) and, on failure, reverts ONLY the
  changed local fields (role/name/email) (+503) **and** best-effort re-mirrors the reverted display name
  back to Zitadel (own try/catch, log-only, never throws over the 503) to converge the one sub-resource
  that could have committed ahead of the failure; `remove` (offboard) runs `deactivateUser` inside the `$transaction`
  so a failure rolls the whole offboarding back. Every write-back is audited. `requestPasswordReset`
  (issue #149) is NOT a mirror but a triggered IdP action — it 404s a missing/soft-deleted user, **422**s
  an inactive one, and 503s a Zitadel Management failure (the email itself is sent by ZITADEL's SMTP).
- `apps/api/src/auth/identity/zitadel-management.service.ts` — the 503 itself was hardened in issue #196
  **without changing this invariant**: (a) the **public** `ServiceUnavailableException` message is now
  GENERIC + actionable (*"The identity provider is temporarily unavailable. Your change was not saved,
  please try again in a moment."*) — the internal verb/path/upstream status no longer leak to the toast
  (`notifyError` surfaces the API message verbatim); the rich detail stays in the WARN log, correlated by
  request id (ADR-0031). (b) `request()` retries a **transient** upstream failure (a network error or a
  `408/429/5xx`) with a bounded exponential backoff + jitter (≤3 attempts, total added latency capped
  ~1.8s, honours `Retry-After`), so a brief Zitadel blip is invisible to the admin while a **sustained**
  outage still falls through to the revert-and-503 path above unchanged. A permanent `4xx` is **never**
  retried, the token/auth fetch is not retried, and the two NON-idempotent writes (create-user `POST
  /v2/users/human`, the grant-ADD `POST .../grants`) single-shot so a lost-response retry can never
  duplicate a user/grant. The **consistency model (strong coupling) is unchanged** — retry only shrinks
  the window in which a *transient* blip trips the revert; it does not relax INV-5. *(The queue/reconcile
  vs. strong-coupling consistency-model question — issue #196 layer (c) — is DEFERRED to a future CEO
  decision and is intentionally not addressed here.)*
- **Exception (deliberate):** `apps/api/src/config/config.service.ts` `setup()` is the one place that
  **degrades instead of blocking** — a first-run mirror failure keeps the local ADMIN (`mirrored:
  false`, warn) rather than 503, so a Zitadel misconfiguration can never wedge first-run (ADR-0043 §6
  #4; the operator repairs Zitadel afterwards).

## INV-6 — Secrets are files on the `zitadel_secrets` volume, never baked in or committed

**Rule.** `ZITADEL_MASTERKEY`, `OIDC_CLIENT_SECRET`, and the Management service-account key are
**mounted secret files** (the `zitadel_secrets` volume / `oidc-client.json` / `sa-key.json`), never
inlined into an image or committed. `infra/env/.env.prod` is `chmod 600` + gitignored. The
service-account credential is **rotatable** (Private-Key JWT at runtime; rotate the bootstrap PAT every
30 days) and scoped as narrowly as Zitadel allows.

**Why.** A secret baked into a layer or committed to git leaks to every puller; file-mounted secrets
stay on the single host and can be rotated without a rebuild.

**Where enforced / documented.**
- `infra/env/.env.prod.example` — `ZITADEL_MASTERKEY` is **exactly 32 bytes**; all `OIDC_*`/`AUTH_*`
  client secrets flow through the sidecar's `oidc-client.json`, not env, in the bundled flow.
- `apps/api/src/auth/identity/zitadel-management.service.ts` — reads the SA key from
  `ZITADEL_MGMT_SA_KEY_PATH` (a mounted file); the key/secret is never logged.
- The `zitadel_secrets` volume is internal-only; the sidecar writes `oidc-client.json` / `sa-key.json`
  world-readable (`0644`) on a single-host internal volume (accepted tradeoff — see
  [[auth-zitadel-sot]] §4e); the machine key stays `0600`.
- Runbooks: [[auth-bootstrap]] §0b (clean re-bootstrap pairs `down -v` with removing the volume),
  [[deploy-self-hosted]], [[backups]] (the masterkey is the DR linchpin).

## INV-7 — DEFAULT VIEWER for new users; first-ever user stays ADMIN

**Rule.** App-created **and** non-first JIT users default to **VIEWER** (least privilege, uniform). The
**first user ever on an empty DB stays ADMIN** so an install is never left un-administrable.

**Why.** New identities should start read-only and be explicitly promoted; but the bootstrap path must
always leave exactly one administrator.

**Where enforced.**
- `apps/api/prisma/schema.prisma` — `User.role @default(VIEWER)`.
- `apps/api/src/users/users.service.ts` — `create` defaults an omitted role to `VIEWER`.
- `apps/api/src/auth/jwt-auth.guard.ts` — JIT insert uses `userCount === 0 ? ADMIN : VIEWER` (explicit
  ADMIN for the first user overrides the column default).
- `apps/api/src/config/config.service.ts` — `setup()` locks the first-run bootstrap role to ADMIN.
- `apps/api/src/users/users.service.ts` — the other half, never leaving **zero usable** ADMINs:
  `assertNotLastAdmin` runs before a demotion away from ADMIN, a deactivation (`isActive=false`) and an
  offboard/delete, and counts only live (`deletedAt: null`) **and active** (`isActive: true`) ADMINs —
  an inactive account cannot authenticate, so it never keeps the instance administrable (SEC-021).
- `apps/api/src/directory/directory-reconcile.service.ts` — the AD/LDAP offboard sweep calls the same
  predicate (`UsersService.hasAnotherActiveAdmin`) and **skips** the last active ADMIN instead of
  deactivating them ([[0091-on-prem-ad-ldap-directory-source]], SEC-021).

## INV-8 — Permissions resolve from `RolePermission` DB rows, never a token claim; the ADMIN set is immutable/full

**Rule.** Fine-grained permissions (Roles & Permissions v2, [[0046-roles-permissions-v2]]) resolve from
the `RolePermission` **database rows**, never from a token claim — the same DB-first rule as roles
(INV-1). The **ADMIN permission set is immutable/full** (the complete catalog): it is never editable,
so an ADMIN is always omnipotent and the last-admin / first-admin invariants (INV-7 + the ADR-0040
last-admin guard) stay intact. ADMIN omnipotence is over **authorization / visibility** only — see
**INV-10** for the deliberate cryptographic exception where even an ADMIN cannot decrypt a zero-knowledge
[[secret-vault]] they are not a crypto member of (capability ≠ cryptographic access). Permissions are **lazyit-local** — they are NEVER mirrored to the IdP;
only the three coarse roles keep their `grantRole` write-back ([[0043-zitadel-source-of-truth]] §3).

**Why.** Permissions are an authorization source, so a forged/misconfigured token must not be able to
confer one; and an editable ADMIN set could strip the last administrator of a power and wedge the
install. Keeping permissions out of the IdP keeps authZ vendor-neutral and BYOI-safe.

**Where enforced.**
- `apps/api/prisma/schema.prisma` — `model RolePermission { role Role; permission String; @@id([role,
  permission]) }`: permissions are DB rows keyed by `(role, permission)`.
- `packages/shared/src/schemas/permission.ts` — the frozen catalog (`PermissionSchema`) + the
  `DEFAULT_ROLE_PERMISSIONS` single source of truth in which `ADMIN` is the **complete** catalog.
- `apps/api/prisma/seed.ts` — seeds the matrix 1:1 from `DEFAULT_ROLE_PERMISSIONS`, **seed-once per
  (role, permission) pair**: a default is granted only when the append-only `applied_role_permission_defaults`
  ledger has never recorded it (`src/prisma/seed-role-permissions.ts`, #1314). The seed never deletes a
  grant, and an admin revocation (which deletes the `RolePermission` row, never the ledger row) survives
  every deploy.
- `apps/api/src/auth/role-permissions.golden.spec.ts` — golden test: a wrong/edited matrix (e.g. an
  incomplete ADMIN set, the pre-tightening drifting, or an admin-only read — `ADMIN_ONLY_READS`, today
  `logs:read` — leaking into MEMBER/VIEWER) fails CI.
- `apps/api/src/auth/permission-resolver.service.ts` — **the runtime resolver (P2):** resolves a role's
  permission set from the `RolePermission` rows via `prisma.rolePermission.findMany` — DB-first, never a
  token claim. ADMIN short-circuits to the COMPLETE catalog (immutable/full) WITHOUT a DB read, so a
  future bad seed can't lock ADMIN out; a catalog-foreign DB row is ignored; an empty seed fails CLOSED.
- `apps/api/src/auth/roles.guard.ts` — **the SINGLE enforcement point (P2→P4):** for a
  `@RequirePermission` route the guard calls the resolver with `request.user.role` (the DB-resolved role
  JwtAuthGuard set, INV-1) and 403s unless the role holds every required permission. The
  `auth/roles.guard.spec.ts` SENTINEL test asserts the role argument is the DB role, never a token/header
  claim. As of P4 this is the ONLY authZ gate the guard understands — `@Public` → `@RequirePermission` →
  open-by-default; the legacy `@Roles` decorator + `ROLES_KEY` + the dual-mode branch are GONE
  (`auth/roles-decorator-retired.spec.ts` fails CI if they return).
- `apps/api/src/auth/permission-parity.golden.spec.ts` — **the parity golden test (P4):** for every
  migrated WRITE route, the role-set its `@RequirePermission` allows (resolved against the seed) must
  EXACTLY equal the role-set the old `@Roles` gate allowed — a mismatch (e.g. an AccessGrant write wired
  to `accessGrant:write` instead of `accessGrant:grant`, or a user-admin route on `user:write` instead of
  `user:manage`) fails CI. This is the behavior-preservation proof for the mechanism swap. **Generalised
  (#555):** a second block asserts every `@RequirePermission` route on the privileged surfaces that had
  no `@Roles` baseline — the Secret Manager, Service-Accounts management, the permission matrix, and the
  whole workflow engine — resolves to **ADMIN-only** (a MEMBER/VIEWER mis-wire fails CI), with a coverage
  guard that each such controller contributes at least one gated route.
- `apps/api/src/config/permissions-config.service.ts` + `apps/api/src/config/config.controller.ts` —
  **the configurable surface (P5):** `GET`/`PUT /config/permissions` (`@RequirePermission('settings:manage')`,
  ADMIN-only) read/replace the MEMBER + VIEWER sets. The **ADMIN-immutable** half of this invariant is
  ACTIVELY enforced here: the strict PUT body (`UpdateRolePermissionsSchema` in
  `packages/shared/src/schemas/permission.ts`) accepts ONLY `MEMBER`/`VIEWER` keys, so an `ADMIN`/extra
  key → 400; the service never writes ADMIN rows, and the resolver's ADMIN short-circuit means a row edit
  could never scope ADMIN down anyway. Every grant/revoke is validated against the frozen catalog
  (unknown → 400), applied in one `$transaction`, and **audited** append-only (`PermissionAuditLog`,
  one immutable row per change attributed to the actor); on commit `PermissionResolverService.invalidate()`
  is called so the next authZ decision is cache-coherent. `GET /config/my-permissions` exposes the
  caller's effective set via the same resolver (no `User`-shape pollution). Covered by
  `apps/api/src/config/permissions-config.service.spec.ts` (round-trip, audit, cache-coherence,
  ADMIN-never-written) and `apps/api/src/config/config.controller.spec.ts` (the `settings:manage` gate:
  MEMBER/VIEWER → 403 on GET/PUT; `my-permissions` open to any authenticated user).
- **As-built (P2+P3+P4+P5, ADR-0046 §Phased delivery):** the `@RequirePermission` guard + the GET
  annotations + ALL the migrated write gates + the editable matrix are now LIVE — the invariant is
  enforced by the runtime guard + resolver, not the schema/seed alone. The only behavior delta is VIEWER
  losing `accessGrant:read` + `user:read` (and the `/search` users facet); see
  `apps/api/src/auth/read-authz-matrix.spec.ts` for the per-role read matrix. The 63 former `@Roles`
  write sites now carry `@RequirePermission` with the EXACT same effective role-set (parity-tested), and
  the legacy `@Roles` path is retired — `@RequirePermission` is the single enforcement primitive. The
  matrix is now ADMIN-editable for MEMBER/VIEWER (audited, cache-coherent), ADMIN immutable (P5).

## INV-SA-1 — A service-account token is verified DB-first; the stored secret is a hash, compared in constant time

**Rule.** A service account ([[0048-service-accounts]]) authenticates with a lazyit-native token
`lzit_sa_<id>_<secret>`. The server stores ONLY a **SHA-256 hash** of the secret (`tokenHash`) + a
non-secret `tokenPrefix`; the cleartext is shown **once** on create/rotate and is never recoverable or
logged. Verification is **DB-first** (INV-1): the `id` segment looks the row up in the DB, the presented
secret's SHA-256 is **constant-time-compared** (`timingSafeEqual`) to the stored `tokenHash`, and a row
that is missing / revoked (`deletedAt`) / inactive (`isActive=false`) / expired (`expiresAt` past) is
rejected — all as a **generic 401** (no enumeration oracle). Never a token claim.

**Why.** A high-entropy random secret needs only a fast hash + constant-time compare (not bcrypt); the
hash-at-rest + once-only reveal means a DB read can never leak a usable credential, and the generic 401
avoids leaking which check failed. BYOI-safe: no IdP on the bot's auth path.

**Where enforced.**
- `apps/api/src/service-accounts/service-account-token.ts` — `mintToken`/`hashSecret`/`verifySecret`
  (constant-time, fails closed on a length/encoding mismatch); never logs a secret.
- `apps/api/src/auth/jwt-auth.guard.ts` — the SA branch runs BEFORE the OIDC/shim branches: parse → look
  up by id INCLUDING soft-deleted (so a revoked account is *seen*) → constant-time secret compare →
  reject revoked/inactive/expired → set `request.principal = {kind:'service', …}`.
- Tests: `apps/api/src/service-accounts/service-account-token.spec.ts`,
  `apps/api/src/auth/jwt-auth.guard.service-account.spec.ts`.

## INV-SA-2 — A service account is FAIL-CLOSED; it does NOT inherit the human open-by-default

**Rule.** A service account passes ONLY `@Public()` routes and routes whose `@RequirePermission(...)` it
**fully holds** (its direct `ServiceAccountPermission` grants, resolved DB-first into a Set). A service
account hitting an **unannotated, non-`@Public` route → 403** — it does NOT inherit the human
open-by-default (INV-8). The human open-by-default for unannotated routes is unchanged.

**Why.** A bot should be able to do *only* what it was explicitly granted; a forgotten gate must not
silently expose an unannotated route to a service account. This is the single most important
authorization difference from a human caller.

**Where enforced.**
- `apps/api/src/auth/roles.guard.ts` — for a service principal, an unannotated route is a 403 (not the
  open-by-default pass); a gated route passes only if its direct grant Set contains EVERY required
  permission. The human path is unchanged.
- `apps/api/src/service-accounts/service-account-permissions.ts` — resolves the grants to a catalog Set;
  a catalog-foreign DB row is ignored (a typo can't confer a power) and there is NO ADMIN/wildcard.
- Tests: `apps/api/src/auth/roles.guard.service-account.spec.ts`,
  `apps/api/src/service-accounts/service-account-permissions.spec.ts`.

## INV-SA-3 — A service account NEVER has a Role, is NEVER ADMIN-equivalent, and never enters human-only logic

**Rule.** A service account is a SEPARATE `ServiceAccount` entity, not a `User`. It has **no `Role`**, is
authorized only by direct permission grants, and can **never** be ADMIN-equivalent. It never enters the
user directory, JIT provisioning, email-linking, or the last-admin / first-admin counts ([[INVARIANTS]]
INV-7) — those operate on `User` rows, which a service account is not.

**Why.** Keeping bots out of the human model means no human-only invariant can be satisfied (or broken)
by a service account, and no bot can accidentally become an administrator.

**Where enforced.**
- `apps/api/prisma/schema.prisma` — `ServiceAccount` is a distinct model (no `role` column); the
  authorization source is `ServiceAccountPermission`, never `Role`/`RolePermission`.
- `apps/api/src/auth/principal.ts` + `roles.guard.ts` — a service principal is authorized by its grant
  Set; the role resolver (`PermissionResolverService`) is **never** consulted for it.
- **(Code-enforced from 2026-06-12, SEC-011, and 2026-09-24, SEC-073 — three complementary layers):**
  - **Layer 1 — schema ceiling (source of truth):** `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS` (exported
    from `packages/shared/src/schemas/service-account.ts`) names the verbs a service account may **never**
    hold — either ADMIN-equivalent (`settings:manage`, `user:manage`) or HUMAN-ONLY by construction
    (`import:run`, ADR-0069; and `secret:read` / `secret:manage`, ADR-0061 — a bot has no vault keypair).
    A `.refine` on `ServiceAccountPermissionsSchema` rejects them with `400` at the DTO edge (create +
    update); the persistence-time `cleanPermissions` also strips them defensively. Golden test:
    `packages/shared/src/schemas/service-account.test.ts`.
  - **Layer 2 — runtime principal guard (backstop):** `ServicePrincipalForbiddenGuard`
    (`apps/api/src/auth/service-principal-forbidden.guard.ts`) throws `403` when `isServicePrincipal(request.principal)`
    is true. Applied at the **class level** of `ServiceAccountsController` (every management route) and
    at the **method level** of `GET /config/permissions` and `PUT /config/permissions`. The Secret
    Manager mirrors this with `HumanOnlyGuard` (`apps/api/src/secret-manager/human-only.guard.ts`) at the
    class level of every Secret-Manager controller, and the import wizard with its own guard. Layer 1
    stops *new* grants; Layer 2 is defense in depth on the routes it guards (Layer 0 below is what makes
    a pre-existing grant inert everywhere). Guard tests: `apps/api/src/auth/service-principal-forbidden.guard.spec.ts`
    and the e2e block in `apps/api/src/config/config.controller.spec.ts`.
    Layer 2 is applied per route, so on its own it misses routes gated on `user:manage`
    (`UsersController`) or `settings:manage` (`PUT /article-categories/:id/access-rules`,
    `PUT /instance/update-settings`) — that gap was
    [[SEC-073-sa-ungrantable-permissions-not-stripped-at-principal-load|SEC-073]].
  - **Layer 0 — principal-load strip (root, from 2026-09-24, SEC-073):** `resolveServiceAccountPermissions`
    (`apps/api/src/service-accounts/service-account-permissions.ts`) drops every
    `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS` literal when the principal is built, DB-first on every
    request (INV-1). A grant row persisted before 2026-06-12 is therefore **inert on every route and
    channel** (HTTP, MCP, headless AI) regardless of which guards a controller carries. The row is not
    deleted: the service-account read shape hides it, the principal loader logs once per account that it
    carries inert grants, and the next admin save of the grant set removes it through the audited
    `PERMISSION_CHANGE` path. Tests: `service-account-permissions.spec.ts` (parity with the shared list),
    `apps/api/src/users/users.sa-ungrantable.authz.spec.ts` (403 on `POST /users` and a role change),
    `ai-tool.write-path.spec.ts` (a headless `user:manage` tool is refused).
  - **Reserved engine-SA name (#555 / #542):** a human can neither create nor rename an account into the
    reserved `lazyit-workflow-engine` name (`EngineServiceAccountService.ENGINE_SA_NAME`) — the immutable
    principal a workflow run executes AS. `ServiceAccountsService.assertNotReservedName` 409's create()
    and update(name), so an admin can never pre-seat a human-token-backed row as the run actor. Test:
    `apps/api/src/service-accounts/service-accounts.service.spec.ts` ("reserved engine-SA name guard").
  - **Residual risk (unchanged):** the SA-actor audit gap (`actorId = null` for SA-performed management
    actions, issue #141) is narrowed by Layer 2 — SAs can no longer perform those management actions at
    all — but the `actorSaId` column is still the clean long-term fix; tracked separately.

## INV-SA-4 — Service-account actions are audited to the service account, never a fake human; at most one actor per audited row

**Rule.** When a service account performs an audited action, the audit/append-only row is attributed to
its `serviceAccountId` (the additive actor column), NEVER a fabricated `userId`. A DB **CHECK** on each
audit-bearing table enforces **at most one** of (human actor, service-account actor) per actor slot —
a row attributed to two principals can never be persisted. Management actions (mint/rotate/revoke/restore/
permission-change) are themselves audited append-only (`ServiceAccountAuditLog`), never recording the secret.

**Why.** Honest attribution: a query for "what did this bot do" must be answerable, and a human must
never be blamed for a bot's action (or vice-versa). The DB CHECK is the guarantee behind the resolver.

**Where enforced.**
- `apps/api/prisma/schema.prisma` + the `add_service_accounts` migration — a nullable `serviceAccountId`
  actor column on the 6 audit-bearing tables (`AssetHistory`, `AssetAssignment` ×2, `AccessGrant` ×2,
  `ConsumableMovement`, `ArticleVersion`, `ArticleLink`) + the at-most-one-actor CHECK per actor slot,
  and the append-only `ServiceAccountAuditLog`.
- `apps/api/src/common/actor.service.ts` — `resolveActor(principal)` returns `{userId}` | `{serviceAccountId}`
  | `{}` so a write lands in the right column.
- **The domain write paths consume it (ADR-0048 wiring):** every audited write reads the unified principal
  (`@CurrentPrincipal()` → `request.principal`, never a token claim) and spreads the resolved attribution
  onto the right column —
  `apps/api/src/asset-history/asset-history.service.ts` (`performedById` XOR `serviceAccountId`, the choke
  point used by `assets.service.ts` + `asset-assignments.service.ts`),
  `apps/api/src/asset-assignments/asset-assignments.service.ts` (`assignedById|releasedById` /
  `assignedBySaId|releasedBySaId`, incl. the offboarding `releaseAllForUser`),
  `apps/api/src/access-grants/access-grants.service.ts` (`grantedById|revokedById` / `grantedBySaId|revokedBySaId`),
  `apps/api/src/consumables/consumables.service.ts` (`performedById` / `serviceAccountId`),
  `apps/api/src/users/users.service.ts` (offboarding's inline grant-revoke + asset-release attribution).
- `apps/api/src/service-accounts/service-accounts.service.ts` — every mutation appends an immutable audit
  row; the secret is never persisted in cleartext nor audited. The controller self-attributes via
  `@CurrentPrincipal` (a human → `actorId`; an SA self-managing SAs records `actorId = null`, honest —
  `ServiceAccountAuditLog` has only a `User` actor FK, no SA actor column yet; a follow-up ADR/migration
  would add one).
- **Out of scope by data model — `Article`:** `Article.authorId` is a **non-null `User` FK** (`onDelete: Restrict`)
  and the author-only edit gate is `User`-identity equality, so a service account cannot author/own an article.
  The article write paths (`articles.service.ts` `requireAuthor`) **reject an SA principal with 403** rather than
  write a null-attributed `ArticleVersion`/`ArticleLink`; those tables' SA actor columns therefore stay
  schema-present but unreachable by design.
- Tests: `apps/api/src/common/actor.service.spec.ts`,
  `apps/api/src/service-accounts/service-accounts.service.spec.ts`, and per-write-path SA-vs-human attribution
  specs in `asset-history`, `assets`, `asset-assignments`, `access-grants`, `consumables`, `articles`,
  `users`; the CHECK + partial-unique index are verified against a throwaway PG18 in the migration's commit
  message.

## INV-9 — KB folder access is enforced at the API + DB layer, never UI-only; no privilege escalation via alias/share

**Rule.** Knowledge-Base access is gated by the article's home **Folder** ([[0060-kb-folder-access-control]]):
which articles a caller may read is evaluated **DB-first at the API layer** and enforced at the **DB layer**,
**never UI-only**. The padlock + tooltip in the UI is presentation; the authoritative decision is the
server's. A folder-hidden article returns **404, not 403** — reusing the [[0022-draft-visibility-auth-shim]]
existence-hiding pattern, so the server never leaks the existence of an article you may not see. This is a
**bounded carve-out** to the "never per-record/per-row ACL" rejection ([[0040-rbac-roles]] /
[[0046-roles-permissions-v2]]): access attaches to a **Folder** (a bounded, named set), **never to individual
article rows**, and is a **second, orthogonal data-scoping axis** layered on the unchanged role→permission
catalog — the `article:read` capability still gates whether you may act at all; the folder ACL only narrows
**which** articles you see. The folder ACL **composes most-restrictive-wins** with draft visibility and
`article:read`. **No-escalation:** you can **never alias or share** an article you cannot yourself access
(an [[article-alias]] never widens access; INV-8 ADMIN omnipotence over visibility is consistent and intact).

**Why.** KB documents are inherently access-tiered in a way assets/consumables are not, so the KB needs a
data-scoping axis the flat per-domain catalog cannot express — but scoping to a **folder** (not a row) keeps
the per-domain authorization model's spirit. UI-only hiding would be trivially bypassable via the API; 404
(not 403) keeps a hidden article's existence secret; the no-escalation rule stops a permitted reader from
laundering access to a folder they cannot see.

**Where enforced (as-built, #404).**
- `apps/api/src/article-categories/folder-access.service.ts` — `FolderAccessService` is the DB-first §4
  read evaluator: it resolves the caller's visible folders honouring the §2 PUBLIC fast-path, the §3 OR
  rules over the **live** [[access-grant]] (`revokedAt IS NULL`) / [[asset-assignment]] (`releasedAt IS
  NULL`) joins (so access follows offboarding automatically), §1 inherit-and-narrow (a child never widens
  past a restricted ancestor), §5 ADMIN god-mode (`'ALL'`) and §8 service-account fail-closed. A
  malformed stored rule fails CLOSED (hidden from non-admins), never silently PUBLIC.
- `apps/api/src/articles/articles.service.ts` — the read path (`findOne`/`findBySlug`/`findPage` +
  versions/links/backlinks/aliases) composes the folder gate most-restrictive-wins with the draft rule
  ([[0022-draft-visibility-auth-shim]]) and `article:read`, **404-ing** a folder-hidden article
  (existence-hiding, never 403). The **reverse KB lookups** (`findArticlesForAsset` /
  `findArticlesForApplication` → `findLinkedArticlesPage` / `buildReverseWhere`, backing
  `GET /assets/:id/articles` and `GET /applications/:id/articles`) thread the caller principal and AND
  the same `categoryId IN <visible>` folder pin on top of the PUBLISHED + link scope, so a restricted
  article never leaks (title/slug/excerpt/existence) through the link scope — ADMIN (`'ALL'`) gets no
  pin (SEC-#553). Both alias and link writes re-check the actor's §4 read access to the TARGET before
  writing (no-escalation, §6): `addAlias` and `addLink` both call `assertFolderVisible` on the
  article's home folder (404 on a hidden folder), so an author who lost folder read cannot launder a
  restricted article via the reverse lookup (SEC-#556).
- `apps/api/src/search/search.service.ts` — `/search` post-filters article hits per caller (the
  search-leak fix): the home folder is carried into the Meili doc (`projectArticle` → `categoryId`,
  a filterable attribute set by `reindex.ts`), then any hit whose folder the caller can't see is dropped
  (ADMIN bypasses; SA/anonymous → PUBLIC only); the internal `categoryId` is stripped before the hit
  ships.
- `apps/api/src/article-categories/article-categories.service.ts` — the category reads
  (`findAll`/`findOne`, backing `GET /article-categories`) use an explicit select that **omits the
  `accessRules` jsonb column** (the folder's permission boundary: allowed user UUIDs + the gating
  role/applicationId/assetId) for an ordinary `category:read` caller, and re-include it **only** for a
  caller holding `settings:manage` (the web rule-editor) — the SAME gate that WRITES the rules. The
  permission is resolved DB-first via `PermissionResolverService` (human role → RolePermission matrix,
  ADMIN full; service account → direct grants); anonymous / no principal fails closed (SEC-#554).
- DB / storage — the rule set is a zod-validated jsonb `accessRules` column on `ArticleCategory`
  (`FolderAccessRulesSchema` in `@lazyit/shared`, a CLOSED `users`/`role`/`appGrant`/`assetAssignment`
  vocabulary), set via `PUT /article-categories/:id/access-rules` (`settings:manage`, ADMIN-only). The
  dynamic rules resolve through `EXISTS`-style reads against the live joins (the soft-delete read filter
  applies); folder-name uniqueness within a parent stays a live-only PARTIAL unique index (ADR-0041).
- Tests: `folder-access.service.spec.ts` (ADMIN-sees-all, SA fail-closed, inherit-narrow-never-widen,
  revoked-grant/released-assignment drops access, malformed-fails-closed), `articles.service.spec.ts`
  (folder-hidden → 404, no-escalation alias AND link, reverse-lookup folder pin), `search.service.spec.ts`
  (restricted hit excluded for a non-matching caller — the leak is closed), `article-categories.service.spec.ts`
  (accessRules omitted for non-admins, returned for `settings:manage`), `folder.test.ts` (the closed
  rule vocabulary).
- Decision + data model: [[0060-kb-folder-access-control]], [[folder]], [[article-alias]].

## INV-10 — Secret Manager values are zero-knowledge; the server can never decrypt a secret value

**Rule.** Secret Manager values ([[0061-secret-manager-zero-knowledge]]) are **zero-knowledge**: the server
**never holds a key that decrypts a secret VALUE**. There is **no server-side `reveal()`** and **no env
master key over values** — a [[secret-item]] persists ONLY ciphertext/iv/authTag/keyVersion encrypted under
the vault **DEK**, which is itself **never stored in clear** (only per-member copies wrapped to each
member's public key exist, [[vault-membership]]). Granting access **wraps the DEK to a member's public key**
([[user-keypair]]) — there is **no grant-what-you-can't-read**. The **recovery key**
(`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`) and the unwrapped private key are shown/derived **once** and are **never
logged or persisted in clear** ([[0031-logging-strategy]]). This is a deliberate, sharp **exception to INV-8**
(ADMIN-omnipotent): ADMIN god-mode is over **authorization/visibility**, **never cryptographic plaintext** —
there is no plaintext for a capability to unlock, so no `secret:manage` holder (ADMIN included) can read a
value they were not cryptographically granted. The new `secret` capability domain (`secret:read` /
`secret:manage`, [[0046-roles-permissions-v2]]) is the *authorization* layer (lets you ENTER); per-vault
crypto membership is a **second, orthogonal** layer (a wrapped DEK lets you DECRYPT). This is a distinct
crypto/threat model from the **server-decryptable** [[workflow-secret]] (ADR-0054), which is decryptable by
design so connectors authenticate at run time — an accepted extra crypto code path to audit.

**Why.** A self-hosted secret store for credentials must survive a full server/DB compromise without leaking
plaintext, so the server is deliberately kept incapable of decryption — a stricter bar than the workflow
connector secrets, which *must* be server-readable to run. Excluding ADMIN from secret values is the price of
zero-knowledge: capability authorization is not cryptographic access, and there is no plaintext for INV-8 to
reach.

**Where enforced (as-built, #366).**
- `apps/api/src/secret-manager/` — the ciphertext-custodian module. Stores ONLY wrapped/encrypted blobs
  (vault DEK never in clear; values as `ciphertext`/`iv`/`authTag`/`keyVersion` mirroring the
  [[workflow-secret]] column shape); exposes **no `reveal()`** and no server-side value decryption.
  Granting writes a DEK **wrapped to the grantee's public key**; a caller can never grant a vault they
  are not themselves a crypto member of. Human-only (`human-only.guard.ts` rejects service principals).
- **INV-10 architectural guard test** (`apps/api/src/secret-manager/inv-10.guard.spec.ts`) — a **merge
  gate** that asserts: (a) no Secret Manager service imports `@noble/*` or any crypto library, (b) no
  `SECRET_MANAGER_KEY`-style env variable is read, and (c) no method in the module returns a plaintext
  value or unwrapped key. INV-10 cannot rot silently — CI fails if the guard is broken.
- `apps/api/prisma/schema.prisma` — [[secret-vault]] / [[secret-item]] / [[vault-membership]] /
  [[user-keypair]] / [[secret-audit-log]]: crypto columns are write-only on the API, never returned in
  clear; plaintext keys/values/passwords/recovery-keys are NEVER persisted or logged ([[0031-logging-strategy]]).
- Decision + data model: [[0061-secret-manager-zero-knowledge]] · [[secret-manager-crypto-design]].

**Programmatic retrieval by a service account ([[0080-service-account-secret-retrieval]], #614) — INV-10
preserved.** An SA can pull a vault's ciphertext headlessly for **client-side** decryption; the server
still never decrypts. The SA gets its own X25519 keypair whose private key is wrapped under
`Argon2id(SA token secret)` (a `ServiceAccountKeypair` — generated **client-side** for **every** SA on
create, and **regenerated under the new token on rotation**, #883; the server never sees the token, the KEK,
or the unwrapped key, so INV-10 holds through the whole lifecycle); a human member re-wraps the vault DEK to
the SA's public key (a `ServiceAccountVaultMembership` — the existing grant flow; a rotation's fresh public
key orphans these, so they are dropped and the SA must be re-granted). The **service-only**
`GET /secret-fetch/:vaultId` (new verb **`secret:fetch`**; `service-only.guard.ts`; `secret:read`/`:manage`
stay SA-ungrantable) returns the SA's **wrapped** private key + the **wrapped** DEK + item **ciphertext**
ONLY — the token→KEK→private-key→DEK→value unwrap chain runs **exclusively in the `lazyit-fetch` CLI**
(`packages/fetch-cli`), never on the server (the INV-10 guard test pins the new fetch path by name). Every
read is audited (`ITEMS_FETCHED`, SA actor). **Residual (accepted):** the token is a per-vault keymaster and
transits the server on the request (`Authorization` header) — mitigated by per-vault scope, audit, and
rotation; the API imports no crypto capable of exploiting it.

## INV-DIR-1 — `directoryOnly = true` ⇒ never login / never administrative role / excluded from bootstrap and last-admin counts

**Rule.** A row with `directoryOnly = true` (a **directory person** created by the bulk import,
[[0069-migrator-import]] §A.3):

1. **Never authenticates until an explicit promotion.** It has `externalId = null` (never set by the
   import) and a `role` that is forced VIEWER; until it is promoted it has no login. Three promotion
   paths exist, each keeping the existing (VIEWER) role: (a) the JIT guard (`jwt-auth.guard.ts`) on a
   verified email match (OIDC); (b) `POST /users/:id/provision-account` (ADMIN, bundled Zitadel) which
   sets `externalId`; and (c) — **local mode only**, issue #1072 — `POST /users/:id/provision-local-account`
   (ADMIN) which sets a `passwordHash` (one-time temp password, `mustChangePassword=true`). All three flip
   `directoryOnly = false`, at which point it is a normal `User`. This is the only amendment to "never
   receives a credential": it is admin-action-gated, never self-service, and never widens the role
   ([[0086-local-authentication-mode]] §5 amendment).
2. **Never holds an administrative role.** `CreateDirectoryPersonSchema` (strict, in `@lazyit/shared`)
   rejects any `role` field. The import path forces VIEWER unconditionally; the regular `PATCH /users`
   path can change the role, but only AFTER the person is promoted (`directoryOnly = false`) — a
   VIEWER directory person can never reach ADMIN status while it remains directory-only.
3. **Excluded from the bootstrap first-user→ADMIN count** and the **last-admin guard count.**
   - `jwt-auth.guard.ts` bootstrap count: `where: { directoryOnly: false, includeSoftDeleted: true }`.
     Importing 200 directory persons cannot hand ADMIN to the first OIDC login.
   - `users.service.ts` last-admin guard: filters `role: ADMIN, isActive: true`. A VIEWER directory
     person is already excluded by the role filter — no extra clause needed.
   - `config.service.ts` setup path: filters `role: ADMIN` — same reasoning.

**Why.** The "is User" shortcut (no `Person` model) means directory persons sit in the `users` table
and would, without this invariant, be counted as "users" in the bootstrap / last-admin logic —
allowing a bulk import to gift ADMIN to the first real login or to block the last-admin guard.

**Where enforced.**
- `apps/api/src/auth/jwt-auth.guard.ts` — bootstrap count gains `where: { directoryOnly: false }`.
- `apps/api/prisma/schema.prisma` — `User.directoryOnly Boolean @default(false)`.
- `packages/shared/src/schemas/user.ts` — `CreateDirectoryPersonSchema` strict (no `role`, no
  `externalId`); `UserSchema` exposes `directoryOnly: z.boolean()`.
- `apps/api/src/import/import-commit.service.ts` — forces `directoryOnly: true`, calls
  `users.service.create` with `skipIdpWriteBack: true` (never calls `idp.createUser` at import time).

## INV-DIR-2 — `directoryOnly = true` ⇒ NEVER the subject of an AccessGrant or IdP provisioning

**Rule.** A directory person (`directoryOnly = true`) cannot be granted access to an application and
cannot be written back to the IdP at import time. Specifically:

1. **No `AccessGrant`.** `AccessGrantsService.assertUserUsable` (enforced before every grant creation
   or renewal) checks `user.directoryOnly` and returns **400** ("a directory person has no account; no
   access can be granted until they log in or are provisioned"). This closes the "is a User → FK works"
   shortcut: the FK to `User` is structurally valid, but the capability is explicitly blocked.
2. **No IdP write-back at import time.** `users.service.create` called with `skipIdpWriteBack: true`
   bypasses the entire Zitadel Management API block. No `idp.createUser`, no `grantRole`, no Zitadel
   user is created. The person exists only in lazyit's DB.
3. **`POST /users/:id/provision-account` is the sole IdP write path** for a directory person. It is
   ADMIN-only, requires a real email (not `@directory.local`), and follows the no-split-brain pattern
   (INV-5): IdP first, local update second; local failure after IdP success is reconcilable via the
   next JIT login.

**Enumerated FK paths to `User` that imply capability (verified against schema):**

| Table / FK | Blocked for directoryOnly? | How |
| --- | --- | --- |
| `AccessGrant.userId` | YES | `assertUserUsable` → 400 |
| `AssetAssignment.userId` | **ALLOWED** (the purpose of directory persons) | — |
| `AccessRequest.requesterId` | Not applicable — directory persons cannot authenticate | No request can be submitted |
| `UserHistory.userId` | Structural — no capability | — |
| External IdP (Zitadel) | YES at import | `skipIdpWriteBack`; only `provision-account` writes to IdP |

**Why.** Without this invariant, an `AccessGrant` created for a directory person would sit permanently
`revokedAt: null` with no way for the person to authenticate and no workflow step to receive it — an
irrevocable, dangling grant. The `assertUserUsable` guard prevents the orphan from being created.

**Where enforced.**
- `apps/api/src/access-grants/access-grants.service.ts` — `assertUserUsable` gains `select { directoryOnly }` + `if (user.directoryOnly) throw 400`.
- `apps/api/src/users/users.service.ts` — `create()` internal opt `{ skipIdpWriteBack?: boolean }` branches before the IdP block when `true`.
- `apps/api/src/users/users.controller.ts` — `provision-account` endpoint (ADMIN-only, `user:manage`).
- Tests: `access-grants.service.spec.ts` — `assertUserUsable` with `directoryOnly=true` → 400.
  `users.service.spec.ts` — `skipIdpWriteBack=true` with `supportsManagement=true` does NOT call `idp.createUser`.

---

# AI assistant, MCP and OAuth invariants (ADR-0097)

The invariants of the AI capability ([[0097-ai-assistant-mcp-and-headless-api|ADR-0097]], epic #1315):
the in-app chat, the MCP server with its OAuth 2.1 authorization server and personal tokens, and the
headless API. They were proposed in [[ai-assistant/_synthesis|the synthesis]] §7 (INV-AI-1…14) and
[[ai-assistant/security|AI security]] §6.9 (INV-AI-15…17), verified by the W4-2 integrated review
([[sweep-2026-09-25-ai-assistant]]) and re-verified against `dev` at `23038bae` (2026-09-26) after the
SEC-080…083 fixes (#1431, #1433), #1428, #1432/#1439 and #1435. They join this note with ADR-0097's
acceptance. `file:line` references are to that commit; the line moves, the function name does not.

They sit **on top of** INV-1, INV-8, INV-10 and INV-SA-1…4, never in place of them: an AI tool call is
an ordinary authenticated request for the principal behind it.

> **Paths.** API paths are relative to `apps/api/src/`; web paths to `apps/web/`. Tests run under Jest
> (API, Node) and `bun test` (web).

## INV-AI-1 — One real principal, exactly its authority

**Rule.** The AI acts as the invoking human (chat, MCP) or Service Account (headless, or MCP with an SA
token), never as a synthetic, system or engine identity. Its authority is the principal's DB-first
permissions ∩ the granted OAuth scope (MCP) ∩ the SA's per-SA AI access setting (headless and SA on
MCP), re-evaluated on **every** tool call together with `ai:use` (chat, headless) or `ai:connect` (MCP)
and the instance switches. Absorbs INV-MCP-2.

**Why.** "Exactly the user's permissions" is the whole security argument of the feature. A second
identity would need a parallel permission map that drifts.

**Where enforced.**
- `auth/delegated-identity.ts:37` — the identity rides a module-private `Symbol()` (not `Symbol.for`),
  so no network request can carry it; `jwt-auth.guard.ts:147` takes that branch first and
  `handleDelegated` (`:210`) re-loads the principal through `PrincipalLoaderService`
  (`principal-loader.service.ts:81-107`: live row, epoch, `isActive`, `directoryOnly`; SAs incl. revoked
  rows).
- `ai/core/ai-tool.service.ts:61-83` — `channelPermission` (`ai:use` / `ai:connect`) and
  `effectiveCeiling` (MCP without a ceiling fails closed to `read`); `list` (`:174`), `invoke`
  (`:231-240`), `propose` and `approve` all call `loadPrincipal` (`:1260`) and re-check the gate.
- `mcp/mcp-caller.ts:40-45` — `scopesToCeiling`; `ai/runtime/principal-context.ts:113-129` — the SA's
  AI access (`off` refused, `read-only` → `['read']`) and the `infra:report` refusal.
- Tests: `auth/jwt-auth.guard.delegated.spec.ts` (DB-reload parity with the network branches; the branch
  is unreachable from the network), `auth/delegated-identity.spec.ts`, `ai/core/ai-tool.write-path.spec.ts`,
  `mcp/mcp-auth.guard.spec.ts`.

## INV-AI-2 — Route-equivalent execution, fail-closed catalog

**Rule.** Every tool executes through the same global guards, handler guards, pipes, controller logic
and service checks as its HTTP route: a controller handler wrapped with `ExternalContextCreator`, invoked
on a synthetic request. A tool may call only the handlers it declares in `bindings`; its permission is
**derived** from the primary binding's `@RequirePermission`, never hand-declared. A tool without a
resolvable permission, an unknown binding, a `@Res`/upload handler, a non-allowlisted guard, an
unrepresentable schema or a missing write preview stops the boot.

**Why.** Authorization in lazyit lives in the HTTP layer (guards, controller logic, the KB folder ACL
inside services). A tool that called services directly would bypass it.

**Where enforced.**
- `ai/core/tool-executor.ts:151-160` — `rt.call` refuses any handler outside the tool's `bindings`.
- `ai/core/route-metadata.ts` — reads `@RequirePermission` with the guard's own override semantics.
- `ai/core/boot-validation.ts:193` (`validateToolsets`) — fails loud; `decidedHandlers` (`:320`) feeds the
  coverage test.
- Tests: `ai/core/tool-route-parity.spec.ts`, `ai/core/tool-coverage.spec.ts` (every controller handler
  is bound or `unexposed`), `ai/core/tool-catalog.golden.spec.ts`, `ai/core/boot-validation.spec.ts`,
  `ai/core/tool-executor.spec.ts`.

## INV-AI-3 — A chat mutation needs a bound, single-use human approval

**Rule.** A chat write is proposed, never invoked: it becomes a server-stored pending action bound to
its principal, conversation, canonical input hash, tool schema hash and target version. Only its owner,
from a human chat session, approves it — atomically, once, before it expires — and the approval carries
no arguments (only the pending-action id, plus the password for step-up). At execute the input hash, the
schema hash, the route authorization and the target version (`STALE`) are re-checked; an approval the
ledger cannot record is not executed. Step-up is derived by core from the closed warning list
`AI_STEP_UP_WARNINGS` (`ROLE_CHANGE`, `IDENTITY_CHANGE`, `PRIVILEGE_GRANT`, `CREDENTIAL_DELIVERY`,
`CRITICAL_APPLICATION`) on the stored **and** the fresh preview, whatever the tool's class. *Auto-approve
(#1376):* an owner may let the conversation approve ordinary writes through the same path — only a
`write`-class tool whose stored and fresh previews are not elevated, need no step-up and name no
untrusted source; the mode is re-checked inside the claim's transaction under the conversation row
lock, and the ledger records `approvalMode = AUTO`. "Approve all" (#1409) is one decision per action,
never a batch endpoint.

**Why.** The model will be fooled sooner or later (security §0). A human decision bound to exactly what
the card showed is the one control injected text cannot forge.

**Where enforced.**
- `ai/core/ai-tool.service.ts` — `invoke` refuses a chat write (`:221-227`, `mustPropose`); `propose`
  requires channel `CHAT`, a human and a `CHAT` tool (`:271-283`); `approve` (`:371`) decides step-up and
  `PREVIEW_CHANGED` on the fresh preview before the claim (`:386-468`), then claims with an atomic
  `updateMany` on `AWAITING_APPROVAL` + owner + unexpired (`:477-503`), write-ahead `APPROVED` (`:521-551`);
  `requireHumanSession` (`:941`); input and schema hashes (`:787`, `:795`); `STALE` (`:839`);
  `autoEligible` (`:99-112`) and the in-transaction mode check (`:486-501`).
- `ai/core/pending-action.ts:85-110` — `AI_STEP_UP_WARNINGS`, `requiresStepUp`;
  `ai/runtime/approval.service.ts:146-153` derives step-up from the stored preview, never the client, and
  `:229` verifies the password through the shared `auth/local/password-step-up.verifier.ts` (per-account
  backoff; the password is never stored).
- `ai/runtime/agent-loop.ts:178-200` — `untrustedRefsOf` (SEC-080, closed): any read whose data carries
  `<untrusted_content>` marks the turn, with its entity refs or the synthetic `toolResult` ref.
- Tests: `ai/core/ai-tool.write-path.spec.ts`, `ai/core/pending-action.spec.ts`,
  `ai/runtime/approval.service.spec.ts`, `ai/runtime/agent-loop.untrusted-sources.spec.ts` (real read tools,
  auto-approve refused after an untrusted read), `ai/runs/ai-runs.http.spec.ts`.

## INV-AI-4 — Untrusted content is data, never authority

**Rule.** No stored content — an article, a note, a description, a search result, a form answer built
from lazyit lists — can alter tool availability, approval requirements, tool metadata or the system
prompt. Other-authored free text reaches the model wrapped in `<untrusted_content>`, and a turn that read
it shows the untrusted-source banner and is never auto-approved. Provider web-search results count as
untrusted for the rest of the conversation.

**Why.** Most of what the AI reads is written by someone other than the person it acts for; the blast
radius must not depend on the model resisting it.

**Where enforced.**
- The catalog, descriptions and schemas are code (`ai/core/tool-registry.ts`); the system prompt is
  frozen per conversation with `AI_PROMPT_VERSION` (`ai/ai.constants.ts:19`, `ai/prompt/system-prompt.ts`).
- `ai/core/result-shaper.ts:18-28` — `untrusted()` wraps and neutralizes nested tags.
- `ai/runtime/agent-loop.ts:178-200` and the run-wide merge (`:1406`); the web-search marker is seeded on
  every later turn (security §6.11).
- Tests: `ai/runtime/agent-loop.untrusted-sources.spec.ts`, `ai/runtime/agent-loop.web-search.spec.ts`,
  `ai/prompt/system-prompt.spec.ts`.

## INV-AI-5 — Secrets never enter model context

**Rule.** One-time credentials, the provider key, workflow, SMTP and directory secrets, and session,
OAuth and personal tokens are never in model context, conversation storage or provider requests. Secret
Manager plaintext never reaches the AI (INV-10). An input form that asks for a credential is refused.
The ledger stores a redacted input.

**Why.** Anything in context can be exfiltrated by the model's output or stored in a transcript that
outlives its purpose.

**Where enforced.**
- `ai/core/exclusions.ts:18-43` — the excluded route prefixes (`secret-manager`, `secret-vaults`,
  `secret-fetch`, `workflow-secrets`, `auth`, `config/ai`, `ai`, `oauth`, `mcp`, `.well-known`) and the
  cleartext-credential handlers (SA create/rotate, `provisionLocalAccount`, `resetPassword`), applied at
  boot (`ai/core/boot-validation.ts:119-124`).
- `ai/core/redaction.ts` — sensitive keys replaced by `[redacted]` in ledger rows.
- `ai/tools/input-request.tools.ts:346` — the credential word list the form validator refuses.
- Tests: `ai/core/boot-validation.spec.ts`, `ai/core/tool-coverage.spec.ts`, `ai/core/action-log.service.spec.ts`,
  `ai/tools/input-request.tools.spec.ts`, `secret-manager/inv-10.guard.spec.ts`.

## INV-AI-6 — Provider key custody

**Rule.** The provider API key is encrypted at rest under its own key axis (`AI_SECRET_KEY`), write-only
(the wire shape carries only `apiKeySet`), never logged, and bound to its destination: changing the
provider or the base URL clears it, and the connection test reuses a stored key only for the same
destination.

**Why.** The key is a billable, often organisation-wide credential; a settings edit must never redirect
it to a new host.

**Where enforced.** `ai/settings/ai-settings.service.ts:315-334` (destination change clears the key),
`:560-573` (redacted wire shape), `:250-252` (connection test), `common/crypto/envelope-cipher.ts`.
Tests: `ai/settings/ai-settings.service.spec.ts`, `ai/settings/ai-connection-tester.spec.ts`.

## INV-AI-7 — Egress is guarded

**Rule.** Provider and CIMD traffic go only through `common/egress` `guardedFetch`: scheme allowlisted,
IP pinned, size and time bounded, no redirects. A private target is reachable only through the explicit,
audited `allowPrivateNetwork` seam for the OpenAI-compatible provider's own configured host; CIMD never.
Loopback and IMDS never. Provider-native web search adds **no** lazyit egress (the provider runs it).
Absorbs INV-MCP-6.

**Why.** An admin-set base URL and a client-supplied `client_id` URL are both attacker-influenced
destinations (SSRF).

**Where enforced.** `ai/providers/provider-fetch.ts:129` (private only with the toggle, for the
configured host), `:172` (`maxRedirects: 0`), `:206` (`guardedFetch`); `oauth/cimd/cimd-fetcher.ts:73-115`
(https only, no userinfo, public addresses only, no redirects, one total deadline including DNS, size
cap); `ai/providers/sdk-import-boundary.spec.ts` keeps the AI SDK inside `ai/providers/`. Tests:
`ai/providers/provider-fetch.spec.ts`, `ai/providers/__compat__/aisdk-guarded-fetch.spec.ts`,
`oauth/cimd/cimd.spec.ts`.

## INV-AI-8 — Model output renders only through the sanitized pipeline

**Rule.** Model output and other-authored text in the chat render through `rehype-sanitize` over the
default schema: no raw HTML, no `dangerouslySetInnerHTML`, no image loads (an image renders as its alt
text), bare URLs not auto-linked, an explicit external link shows its full URL, web sources `http(s)`
only, and every internal href is built by the web, never taken from the API.

**Why.** A transcript is attacker-influenced text shown inside an authenticated session.

**Where enforced.** `components/ai/ai-markdown.tsx:126` (sanitize), `:100` (images as text);
`lib/ai/chat-links.ts`; `lib/ai/web-sources.ts`; `lib/ai/entity-href.ts` (`safeInternalPath`). Tests:
`components/ai/ai-markdown.test.tsx`, `lib/ai/chat-links.test.ts`, `lib/ai/web-sources.test.ts`,
`lib/ai/entity-href.test.ts`, `lib/ai/untrusted-text.test.ts`.

## INV-AI-9 — OAuth and MCP tokens are audience-bound and isolated

**Rule.** OAuth access and refresh tokens and personal tokens are opaque, 256-bit CSPRNG, SHA-256-hashed
at rest, shown once, never logged, expiring, and bound to the canonical `/mcp` resource. They are
accepted on `/mcp` only, and `/mcp` accepts nothing else: `lzit_oat_` on an HTTPS instance, `lzit_pat_`
on `lan` only, and `lzit_sa_` only for an SA holding `ai:connect`. Session JWTs are never accepted on
`/mcp`, and MCP tokens never on REST routes. Codes are single-use, ≤ 60 s and PKCE-S256-bound; redirects
match exactly (loopback port-agnostic only; userinfo and fragments refused); refresh tokens rotate, and
reuse outside the 30 s grace window revokes the grant; `iss` is returned; the issuer is pinned. A grant
dies with the user: soft delete, `isActive = false`, `directoryOnly`, an `mcpCredentialEpoch` bump (a
password change or reset, an admin reset or *revoke sessions*, the recovery CLI, a deactivation, an
offboarding — **not** a plain web logout, ADR-0097 decision 8 as amended) or `mustChangePassword`.
Absorbs INV-MCP-1, -3 and -4.

**Why.** A token passthrough or a token valid elsewhere turns one leaked MCP credential into a session.

**Where enforced.**
- `oauth/oauth-crypto.ts:14-45` — mint (`randomBytes`) and hash; `oauth/oauth.constants.ts:8-14` —
  lifetimes.
- `oauth/oauth-token.service.ts:153` (code claimed by an atomic update first), `:163-174` (resource),
  `:283-285` (refresh reuse revokes), `:470-504` (`verifyAccessToken`: grant live, audience, user
  re-loaded at `mcpCredentialEpoch`, `mustChangePassword`).
- `oauth/authorization.service.ts:339-341` (S256 only); `oauth/client-policy.ts:143-155` (exact match).
- `oauth/personal-tokens/personal-tokens.service.ts:305` (`lan` only), `:163` (never `lazyit.admin`),
  `:336-340`.
- `mcp/mcp-auth.guard.ts:186-310` (per-prefix verification, SA `ai:connect` / `infra:report` / AI
  access); `auth/principal-loader.service.ts:63-107`.
- Tests: `oauth/token-isolation.spec.ts` (OAuth tokens refused by the REST guard), `oauth/oauth-flow.spec.ts`,
  `oauth/oauth-crypto.spec.ts`, `oauth/client-policy.spec.ts`, `oauth/personal-tokens/personal-tokens.service.spec.ts`,
  `mcp/mcp-auth.guard.spec.ts`, `auth/local/login.service.spec.ts` (logout leaves `mcpCredentialEpoch`).

## INV-AI-10 — Every AI-initiated mutation is permanently audited

**Rule.** `AiActionLog` is the single ledger for every channel: one row per write lifecycle event
(`PROPOSED`, `APPROVED`, `ATTEMPTED`, `EXECUTED`, `FAILED`, …), attributed human XOR Service Account
(INV-SA-4) with channel and approval provenance, written **before** execution, independent of
conversation retention, and blocked against `UPDATE` and `DELETE` at the database (only the actor FKs'
own `ON DELETE SET NULL` may change a row). Asset and user history rows stamp `aiInvocationId`.

**Why.** Transcripts are allowed to forget; the record of what the AI changed is not.

**Where enforced.** `prisma/migrations/20260806000000_add_ai_assistant_and_oauth/migration.sql:470`
(one-actor CHECK), `:482-506` (the append-only trigger); `ai/core/action-log.service.ts`;
`ai/core/ai-tool.service.ts:521-551` (write-ahead on approve) and `:718` (`ATTEMPTED` before an MCP or
headless write); `ai/core/invocation-context.ts` (the ALS stamp). Tests: `ai/core/action-log.service.spec.ts`
(append-only in application code), `ai/core/ai-tool.write-path.spec.ts`. The trigger itself has no
database-level test (the Jest suite runs without Postgres).

## INV-AI-11 — Consumption is bounded

**Rule.** Step, tool-call (30 per run), pending-per-step (5), output, token-budget (per principal per
24 h), concurrency (3 active runs, 8 streams per principal), rate (per principal; per grant and per IP on
`/mcp`) and per-SA mutation limits are enforced server-side, persisted where they must survive a restart,
and fail closed. A batch counts its rows toward the per-SA mutation cap (SEC-081, closed). The `/mcp`
query-token scan is charged to the per-IP limiter before it runs (SEC-083, closed).

**Why.** A model in a loop, or a script holding an SA token, must not exhaust the provider budget or
the instance.

**Where enforced.** `ai/runtime/runtime.constants.ts:23-40`; `ai/runtime/limits.ts` (`TokenBucket`,
`budgetExceeded` over persisted `ai_usage`); `ai/runtime/agent-loop.ts:365`, `:739`, `:949`, `:992-1015`;
`ai/core/mutation-weight.ts`; `mcp/mcp-server.factory.ts:122-160`; `ai/runs/run-event-stream.ts:34`;
`mcp/mcp-rate-limit.ts`; `mcp/mcp-auth.guard.ts:111-119`. Tests: `ai/core/mutation-weight.spec.ts`,
`ai/runtime/agent-loop.spec.ts`, `ai/runtime/agent-loop.untrusted-sources.spec.ts`,
`mcp/mcp-server.factory.spec.ts`, `mcp/mcp-auth.guard.spec.ts`, `ai/runs/run-event-stream.http.spec.ts`.
Two limits are soft by design (provider §8.1): the active-run cap is counted outside the creating
transaction and the budget is checked before a step, so either can overshoot by one.

## INV-AI-12 — Off by default and gated by mode

**Rule.** The chat is disabled until an admin enables it after a passing connection test and an
acknowledged egress disclosure; MCP has its own switch, independent of the provider; every AI, OAuth and
MCP route answers 404 while its switch is off. Nothing is available under `AUTH_MODE=shim`. The OAuth
authorization server exists only with a pinned HTTPS origin; on `lan`, MCP authenticates with personal
tokens only.

**Why.** An operator who never enables AI must see no new surface, including during guided updates.

**Where enforced.** `ai/settings/ai-settings.service.ts:120-122` (shim), `:356-399` (the enable gate);
`mcp/mcp-auth.guard.ts:123-125` (shim and switch → 404); `oauth/oauth-config.ts` (null without a pinned
HTTPS origin or in shim); `ai/status/ai-status.service.ts`. Tests: `ai/settings/ai-settings.service.spec.ts`,
`ai/status/ai-status.service.spec.ts`, `oauth/oauth-config.spec.ts`, `mcp/mcp-auth.guard.spec.ts`.

## INV-AI-13 — No OIDC path

**Rule.** The authorization server contains no OIDC or IdP code: no `id_token`, no userinfo, no
`openid-configuration`, no `openid` scope (#1310). Absorbs INV-MCP-5.

**Where enforced.** `oauth/oauth-token.service.ts:37`, `oauth/metadata.controller.ts:8`. Test:
`oauth/oauth-http.spec.ts:135` (no discovery document, no OIDC field in the metadata);
`oauth/oauth-flow.spec.ts` (`openid` is `invalid_scope`).

## INV-AI-14 — The catalog exclusions are structural

**Rule.** No Secret Manager tool, no tool that returns a credential in cleartext, no tool over the AI's
own configuration and no generic egress tool (fetch, email compose, raw query) exists on any channel;
SA-ungrantable verbs stay ungrantable. Provider-native web search is a model-call option, not a lazyit
tool. Absorbs INV-MCP-7.

**Where enforced.** `ai/core/exclusions.ts:18-43`, `ai/core/boot-validation.ts:119-124` (an excluded
route cannot be bound). Tests: `ai/core/boot-validation.spec.ts`, `ai/core/tool-coverage.spec.ts`,
`ai/core/tool-catalog.golden.spec.ts`.

## INV-AI-15 — No unattended outbound integration

**Rule.** A workflow, a workflow version or a workflow connection is created, changed, tested or enabled
by the AI only through a chat approval by a human. No Service Account and no MCP client does it. MCP and
headless refuse every write on a critical application (`AI_CHANNEL_REFUSED_WARNINGS`).

**Where enforced.** `ai/tools/workflow-authoring.tools.ts` — all nine authoring tools declare
`channels: ['CHAT']` (`:781` … `:2073`) and re-check chat + human in `preview` and `run`
(`assertChatHuman`, `:229`); `ai/core/ai-tool.service.ts:216` (`invoke` on another channel) and
`:271-283` (`propose`); `ai/core/pending-action.ts:116-160` (`assertChannelAllows`). Tests:
`ai/tools/workflow-authoring.tools.spec.ts`, `ai/core/pending-action.spec.ts`, `ai/tools/access.tools.spec.ts`.

## INV-AI-16 — Workflow secrets are reference-only

**Rule.** The AI never reads, sets or rotates a workflow secret value; it may state whether a connection
has a credential configured, and header values come back as `[redacted]`.

**Where enforced.** `ai/core/exclusions.ts:22` (`workflow-secrets`); `ai/tools/workflow-authoring.tools.ts:596`
(`credentialConfigured` from `secretId`); header redaction in the connection read (SEC-075, closed).
Test: `ai/tools/workflow-authoring.tools.spec.ts`.

## INV-AI-17 — A Service Account operates workflows, it never builds them

**Rule.** Over headless, a Service Account gets the workflow reads, run retry and replay, and the
resolution of **unassigned** manual tasks. It never authors a workflow or a version, never creates,
changes, tests or archives a connection, and never enables or disables a workflow — a CEO decision
(#1344), permanent, whatever MCP authoring later becomes.

**Where enforced.** The `CHAT`-only channels above; `ai/tools/workflows.tools.ts:1403-1407` (the route's
assignee guard: an SA has no user id, so only an unassigned task passes). Tests:
`ai/tools/workflows.tools.spec.ts`, `ai/tools/workflow-authoring.tools.spec.ts`.

## INV-MCP-1…7 — where they live now

The MCP design ([[ai-assistant/mcp-and-oauth|MCP]] §7) proposed seven INV-MCP invariants. They are
merged into the INV-AI set and enforced there; the mapping is kept so a finding that cites one still
resolves.

| INV-MCP | Rule, in short | Now |
| --- | --- | --- |
| INV-MCP-1 | Opaque, hashed, shown-once tokens, accepted only on `/mcp`; session JWTs never on `/mcp`, MCP tokens never on REST | INV-AI-9 |
| INV-MCP-2 | An MCP call's authority = current DB permissions ∩ scope, re-evaluated on every request with `ai:connect` and the switch | INV-AI-1 |
| INV-MCP-3 | A grant dies with the user (soft delete, inactive, directory-only, `mcpCredentialEpoch` bump, `mustChangePassword`) | INV-AI-9 |
| INV-MCP-4 | Single-use ≤ 60 s PKCE-S256 codes, exact redirects, rotating refresh with reuse revocation, `iss` | INV-AI-9 |
| INV-MCP-5 | No OIDC code path in the authorization server | INV-AI-13 |
| INV-MCP-6 | CIMD fetched only through `guardedFetch` | INV-AI-7 |
| INV-MCP-7 | No Secret Manager, credential-returning or AI-configuration tool on any channel | INV-AI-14 |

---

Related: [[0043-zitadel-source-of-truth]] · [[0046-roles-permissions-v2]] · [[0048-service-accounts]] ·
[[0060-kb-folder-access-control]] · [[0061-secret-manager-zero-knowledge]] · [[0031-logging-strategy]] ·
[[auth-zitadel-sot]] · [[0038-jit-user-provisioning]] · [[0040-rbac-roles]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0028-secrets-and-config]] · [[deferred]] · [[summary]] · [[_MOC]] ·
[[0069-migrator-import]] · [[user]] ·
[[0097-ai-assistant-mcp-and-headless-api]] · [[ai-assistant/security]] · [[sweep-2026-09-25-ai-assistant]]
