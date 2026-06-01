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

---

Related: [[0043-zitadel-source-of-truth]] · [[auth-zitadel-sot]] · [[0038-jit-user-provisioning]] ·
[[0040-rbac-roles]] · [[0041-soft-delete-reuse-and-restore]] · [[0028-secrets-and-config]] ·
[[deferred]] · [[summary]] · [[_MOC]]
