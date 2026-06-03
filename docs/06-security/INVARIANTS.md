---
title: Security invariants (auth / authZ)
tags: [security, invariants, auth, authz, oidc, rbac, zitadel]
status: accepted
created: 2026-06-01
updated: 2026-06-01
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

## INV-2 — Account-linking by email is claim-only, race-safe, and never steals

**Rule.** First-login email linking claims **only** rows with `externalId IS NULL` that are **live**
(`deletedAt IS NULL`). It NEVER re-binds an email already linked to a different `sub` (returns/keeps a
409-style rejection), and soft-deleted rows are invisible — an offboarded user's email is never
resurrected by a returning `sub`.

**Why.** Linking is the mechanism by which a real operator inherits a seeded ADMIN row; a sloppy link
would be an account-takeover or a resurrection of an offboarded identity.

**Where enforced.**
- `apps/api/src/auth/jwt-auth.guard.ts` — the link is a race-safe `updateMany` guarded by
  `externalId: null` (+ the soft-delete read filter); a row already bound to a different `sub` is not
  re-bound, and `externalId` stays **fully `@unique`** (ADR-0038/0041) so a returning `sub` cannot
  resurrect a soft-deleted row.
- Carried unchanged from [[0038-jit-user-provisioning]] / [[0041-soft-delete-reuse-and-restore]]; see
  [[deferred]] DEF-002 for the trusted-IdP framing.

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
  `warn` (`supportsManagement = false`).
- `apps/api/src/auth/identity/zitadel-management.service.ts` — the constructor never throws; a missing
  credential WARNs at boot-config resolution and throws "Zitadel management not configured" from the
  *management methods only*, never on the authN path.
- `apps/api/src/auth/boot-config.ts` — boot validation warns (does not fail) on an absent Management
  credential.

## INV-5 — Write-back is no-split-brain: a Management failure rolls back and surfaces 503

**Rule.** When lazyit mirrors a user/role change to Zitadel and the Management call fails, the **local
change is rolled back** (or compensated) and the request returns **503** — never a silent partial
write. Offboarding deactivates the IdP user **inside the offboard transaction**.

**Why.** A soft-deleted-local / still-active-in-IdP (or role-changed-local / un-mirrored) divergence is
a security drift; failing loud with 503 keeps the two stores consistent.

**Where enforced.**
- `apps/api/src/users/users.service.ts` — `create` hard-deletes the just-created local row on a mirror
  failure (+503); a role change reverts the local role on a `grantRole` failure (+503); `remove`
  (offboard) runs `deactivateUser` inside the `$transaction` so a failure rolls the whole offboarding
  back. Every write-back is audited.
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
last-admin guard) stay intact. Permissions are **lazyit-local** — they are NEVER mirrored to the IdP;
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
  incomplete ADMIN set, or the pre-tightening drifting) fails CI.
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

---

Related: [[0043-zitadel-source-of-truth]] · [[0046-roles-permissions-v2]] · [[auth-zitadel-sot]] ·
[[0038-jit-user-provisioning]] · [[0040-rbac-roles]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0028-secrets-and-config]] · [[deferred]] · [[summary]] · [[_MOC]]
