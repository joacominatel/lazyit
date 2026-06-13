---
title: Security invariants (auth / authZ)
tags: [security, invariants, auth, authz, oidc, rbac, zitadel]
status: accepted
created: 2026-06-01
updated: 2026-06-12
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
- `apps/api/prisma/seed.ts` — seeds the matrix 1:1 from `DEFAULT_ROLE_PERMISSIONS` (idempotent upsert).
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
  `user:manage`) fails CI. This is the behavior-preservation proof for the mechanism swap.
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
- **(Code-enforced from 2026-06-12, SEC-011 — two complementary layers):**
  - **Layer 1 — schema ceiling (source of truth):** `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS` (exported
    from `packages/shared/src/schemas/service-account.ts`) names the two coarse principal/authz-management
    verbs that a service account may **never** hold: `settings:manage` and `user:manage`. A `.refine` on
    `ServiceAccountPermissionsSchema` rejects them with `400` at the DTO edge (create + update); the
    persistence-time `cleanPermissions` also strips them defensively. Golden test:
    `packages/shared/src/schemas/service-account.test.ts`.
  - **Layer 2 — runtime principal guard (backstop):** `ServicePrincipalForbiddenGuard`
    (`apps/api/src/auth/service-principal-forbidden.guard.ts`) throws `403` when `isServicePrincipal(request.principal)`
    is true. Applied at the **class level** of `ServiceAccountsController` (every management route) and
    at the **method level** of `GET /config/permissions` and `PUT /config/permissions`. This closes the
    class for pre-existing rows: Layer 1 stops *new* grants; Layer 2 stops *use* of any pre-existing
    meta-verb grant. Guard tests: `apps/api/src/auth/service-principal-forbidden.guard.spec.ts` and the
    e2e block in `apps/api/src/config/config.controller.spec.ts`.
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
  (existence-hiding, never 403). `addAlias` re-checks the actor's §4 read access to the TARGET before
  writing the alias row (no-escalation, §6).
- `apps/api/src/search/search.service.ts` — `/search` post-filters article hits per caller (the
  search-leak fix): the home folder is carried into the Meili doc (`projectArticle` → `categoryId`,
  a filterable attribute set by `reindex.ts`), then any hit whose folder the caller can't see is dropped
  (ADMIN bypasses; SA/anonymous → PUBLIC only); the internal `categoryId` is stripped before the hit
  ships.
- DB / storage — the rule set is a zod-validated jsonb `accessRules` column on `ArticleCategory`
  (`FolderAccessRulesSchema` in `@lazyit/shared`, a CLOSED `users`/`role`/`appGrant`/`assetAssignment`
  vocabulary), set via `PUT /article-categories/:id/access-rules` (`settings:manage`, ADMIN-only). The
  dynamic rules resolve through `EXISTS`-style reads against the live joins (the soft-delete read filter
  applies); folder-name uniqueness within a parent stays a live-only PARTIAL unique index (ADR-0041).
- Tests: `folder-access.service.spec.ts` (ADMIN-sees-all, SA fail-closed, inherit-narrow-never-widen,
  revoked-grant/released-assignment drops access, malformed-fails-closed), `articles.service.spec.ts`
  (folder-hidden → 404, no-escalation alias), `search.service.spec.ts` (restricted hit excluded for a
  non-matching caller — the leak is closed), `folder.test.ts` (the closed rule vocabulary).
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

**Where enforced.**
- **Future** `apps/api/src/secret-manager/**` — stores ONLY wrapped/encrypted blobs (vault DEK never in
  clear; values as ciphertext/iv/authTag/keyVersion mirroring the [[workflow-secret]] column shape); exposes
  **no `reveal()`** and no server-side value decryption. Granting writes a DEK **wrapped to the grantee's
  public key**; a caller can never grant a vault they are not themselves a crypto member of.
- **Future** `apps/api/prisma/schema.prisma` — [[secret-vault]] / [[secret-item]] / [[vault-membership]] /
  [[user-keypair]]: crypto columns are write-only on the API, redacted on read, never returned; plaintext
  keys/values/passwords/recovery-keys are NEVER persisted or logged ([[0031-logging-strategy]]).
- Decision + data model: [[0061-secret-manager-zero-knowledge]].

---

Related: [[0043-zitadel-source-of-truth]] · [[0046-roles-permissions-v2]] · [[0048-service-accounts]] ·
[[0060-kb-folder-access-control]] · [[0061-secret-manager-zero-knowledge]] · [[0031-logging-strategy]] ·
[[auth-zitadel-sot]] · [[0038-jit-user-provisioning]] · [[0040-rbac-roles]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0028-secrets-and-config]] · [[deferred]] · [[summary]] · [[_MOC]]
