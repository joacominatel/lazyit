---
title: "ADR-0048: Service Accounts — a non-human principal with a lazyit-native token + direct permission grants"
tags: [adr, auth, authz, service-accounts, permissions, security]
status: accepted
created: 2026-06-02
updated: 2026-06-02
deciders: [Joaquín Minatel]
---

# ADR-0048: Service Accounts — a non-human principal with a lazyit-native token + direct permission grants

## Status

**accepted** — 2026-06-02 (CEO-approved shape). This ADR **extends** [[0040-rbac-roles]],
[[0043-zitadel-source-of-truth]] and [[0046-roles-permissions-v2]]: it adds a SECOND kind of
authenticated principal (a non-human service account) that reuses ADR-0046's frozen permission catalog
but is authenticated by a lazyit-native token (not the IdP) and authorized by direct grants (not a
role). It re-affirms the auth INVARIANTS ([[INVARIANTS]]) and adds the service-account ones
(INV-SA-1…4). The backend is delivered in this wave; the **frontend admin UI is delivered as a
fast-follow** (the `/settings/service-accounts` screen, gated on `settings:manage`), and the
**Zitadel machine-user mirror is deferred** to a future ADR (the IdP seam stays open; BYOI no-ops).

## Context

Until now every authenticated caller is a **human** (`User`) provisioned via OIDC/JIT
([[0038-jit-user-provisioning]]) and authorized by a `Role` → permission matrix
([[0046-roles-permissions-v2]]). But automation needs to call the API too: a CI runner that registers
a freshly imaged asset, a nightly script that reconciles consumable stock, an integration that opens
access grants. Today the only way to do that is to mint a human user and share its OIDC token — which
pollutes the user directory, counts toward the last-admin / first-admin invariants ([[INVARIANTS]]
INV-7), depends on the IdP being reachable, and gives the bot a coarse `Role` (often more than it
needs). The CEO asked for a **first-class non-human principal**, designed clean and reusable, that the
ADR-0046 permission catalog already anticipated ("fundación unificada + SA fast-follow").

Constraints carried from the auth arc:

- **DB-first authorization (INV-1).** A privilege decision never trusts a token claim; it reads the DB.
- **BYOI / vendor-neutral ([[0037-idp-choice-zitadel-byoi]]).** Auth must work with any OIDC IdP — and
  for a bot, ideally with NO IdP dependency at all.
- **Auditability by default ([[0006-soft-delete-and-auditing]]).** Who did what must be reconstructable,
  including when "who" is a service account.
- **Humans stay UNCHANGED.** The human table, JIT, role resolution and the last-admin guard must not be
  touched or weakened.

The CEO's framing (quoted, do not re-litigate):

- **A SEPARATE `ServiceAccount` model** — not a `type` flag on `User`, not a Zitadel machine-user.
- **Auth = a lazyit-native token** stored as a hash, shown once, BYOI-safe.
- **AuthZ = direct grants from the SAME catalog** humans use; never the `Role` enum, never ADMIN.
- **Audit attribution** for service-account actions.
- **Optional expiry + one-click rotate**; no forced expiry for v1.
- **Defer the Zitadel machine-user mirror**; keep the IdP seam open.

## Considered options

### Fork #1 — Where does a service account live?

- **A: a `type`/`isServiceAccount` flag on `User`.** Reuses the table, but every human-only assumption
  (JIT email-linking, last-admin count, the directory listing, `externalId`) would have to grow a
  "unless it's a bot" branch. Fragile; one missed branch is a security bug. ❌
- **B (chosen): a separate `ServiceAccount` model.** The human table is untouched — a service account
  *cannot* enter JIT, the directory, or the last-admin math because it is a different entity. Clean
  separation; the small cost is a parallel CRUD + a second principal kind in the guards. ✅
- **C: a Zitadel machine-user.** Couples bot auth to the IdP (breaks BYOI; a generic OIDC IdP may not
  offer machine users), and puts the IdP on the bot's runtime auth path. ❌ (deferred as an *optional
  mirror* — future ADR.)

### Fork #2 — How does a service account authenticate?

- **A (chosen): a lazyit-native token** `lzit_sa_<id>_<secret>`. The secret is `crypto.randomBytes(32)`
  base64url (256 bits), stored as a **SHA-256 hash** (+ a short non-secret `tokenPrefix` for display),
  verified by a constant-time compare. BYOI-safe (no IdP), simple, revocable in our own DB. ✅
- **B: an OIDC client-credentials token from the IdP.** Re-introduces the IdP dependency on the bot's
  runtime path and the BYOI problem. ❌
- **Hashing choice:** a high-entropy random secret does NOT need a slow password hash (bcrypt/argon2);
  those exist to slow brute-forcing of LOW-entropy human passwords. A fast SHA-256 + `timingSafeEqual`
  is correct and adds no per-request latency. The token is shown **once**; only the hash is persisted.

### Fork #3 — How is a service account authorized?

- **A: give it a `Role`.** Couples bots to the human role model and risks an ADMIN-equivalent bot. ❌
- **B (chosen): direct grants from the SAME `@lazyit/shared` catalog.** A `ServiceAccountPermission`
  join lists the exact `domain:action` literals it holds. Never a `Role`, never ADMIN-equivalent. The
  catalog is the single source of truth (a typo can't mint a power). ✅
- **Default posture:** a service account is **FAIL-CLOSED** — it passes only `@Public` routes and routes
  whose `@RequirePermission(...)` it *fully* holds. It does NOT inherit the human **open-by-default**
  for unannotated routes (INV-8). This is the single most important authZ difference from a human: a bot
  that hits an unannotated, non-`@Public` route gets **403**, not a pass.

### Fork #4 — How are service-account actions audited?

- **A: a fake `userId`.** Pollutes the human attribution and lies about who acted. ❌
- **B (chosen): a nullable `serviceAccountId` actor column** on each audit-bearing append-only table,
  with a DB **CHECK** that at most one of (human actor, service-account actor) is set. `ActorService`
  resolves the unified principal to the right column. Honest, queryable, DB-enforced. ✅

## Decision

Add a first-class **`ServiceAccount`** principal:

1. **Data (one migration).**
   - `ServiceAccount` (`cuid` id, `name`, `description?`, `tokenHash`, `tokenPrefix`, `isActive`
     default true, `expiresAt?`, `lastUsedAt?`, `createdById` → `users` SetNull, `createdAt`/`updatedAt`/
     `deletedAt` soft-delete). `tokenHash` is unique among **live** rows via a **partial unique index**
     `WHERE "deletedAt" IS NULL` (raw SQL — soft-delete-reuse precedent, [[0041-soft-delete-reuse-and-restore]]).
   - `ServiceAccountPermission` (composite PK `(serviceAccountId, permission)`, the catalog literal as a
     plain `String` — same rationale as `RolePermission`). **The authorization source — never a role.**
   - `ServiceAccountAuditLog` (append-only, autoincrement id; `MINT`/`ROTATE`/`REVOKE`/`RESTORE`/
     `PERMISSION_CHANGE`; `actorId` → `users` SetNull; optional `detail` jsonb). The secret is never recorded.
   - An additive nullable **`serviceAccountId` actor column** on the **6 audit-bearing tables**
     (`AssetHistory`, `AssetAssignment` ×2 actors, `AccessGrant` ×2 actors, `ConsumableMovement`,
     `ArticleVersion`, `ArticleLink`) + an **at-most-one-actor CHECK** per actor slot (human XOR service).
2. **Token (`apps/api/src/service-accounts/service-account-token.ts`).** `mintToken` / `parseToken` /
   `hashSecret` / `verifySecret` (constant-time). Format `lzit_sa_<id>_<secret>`; the id segment lets the
   guard look the row up directly. No secret is ever logged.
3. **Guard.** The **`JwtAuthGuard` SA branch runs BEFORE OIDC/shim**: a `Bearer lzit_sa_…` token is
   parsed, the account is looked up by id (including soft-deleted, so a revoked account is *seen* and
   rejected), the secret is constant-time-compared, and a revoked / inactive / expired account is
   rejected — all as a **generic 401** (no enumeration oracle). On success it sets
   `request.principal = {kind:'service', serviceAccount, permissions}` (+ `request.serviceAccount`), and
   leaves `request.user` undefined. Humans keep setting `request.user`, now mirrored onto
   `request.principal = {kind:'human', user}`. The **`RolesGuard`** authorizes a service account by its
   direct grant set (fail-closed); humans are unchanged.
4. **Management API.** `@RequirePermission('settings:manage')`-gated `/service-accounts`: `POST` (create
   → token once), `GET /` (list; `?includeRevoked`), `GET /:id`, `PATCH /:id` (rename/description/
   permissions/isActive/expiresAt), `POST /:id/rotate` (new secret once, old invalidated), `DELETE /:id`
   (soft-delete = revoke), `POST /:id/restore`. Every mutation appends an audit row.
5. **Shared contract (`@lazyit/shared`).** `ServiceAccountSchema` (no secret — `tokenPrefix` only),
   `CreateServiceAccountSchema` (name + permissions[], no token field), `UpdateServiceAccountSchema`, and
   the once-only `ServiceAccountWithSecretSchema`. Permissions validated against the existing
   `PermissionSchema` catalog.

## Consequences

- **Positive.**
  - Automation gets a clean, revocable, least-privilege credential without polluting the human directory
    or the last-admin math, and **without any IdP dependency** (BYOI-safe).
  - The permission model is **unified**: bots and humans speak the same `domain:action` vocabulary; the
    catalog stays the single source of truth.
  - **Fail-closed by construction:** a bot can only do what it was explicitly granted; an unannotated
    route is denied, so a forgotten gate doesn't expose data to a bot.
  - **Honest, DB-enforced audit:** SA actions are attributed to the service account, never a fake human,
    and the CHECK makes a two-actor row impossible.
- **Negative / trade-offs.**
  - A second principal kind adds a branch to the two guards and a parallel CRUD surface (mitigated: the
    `RolesGuard` change is behavior-preserving for humans, and the existing 744-test suite stays green).
  - The token is shown **once** — losing it means rotating, not recovering (intentional; the cleartext is
    never persisted).
  - No forced expiry in v1 (optional `expiresAt` only) — operational hygiene (rotation cadence) is left
    to the operator for now.
- **System-managed accounts (issue #304).** The workflow engine auto-provisions a singleton,
  least-privilege **engine SA** (reserved name `lazyit-workflow-engine`, [[0054-applications-workflow-engine]] §6)
  that every workflow run **executes as** — it is the audited run actor, so it must always exist and stay
  live. That row is therefore **locked**: `update` / `rotate` / `revoke` reject it with a **409** (it can't
  be renamed, re-granted, disabled via `isActive=false`, token-rotated, or soft-deleted), identified by the
  **reserved name** (single source of truth on `EngineServiceAccountService.ENGINE_SA_NAME`). The wire
  `ServiceAccountSchema` carries a `systemManaged:boolean` (default `false`) so the admin UI gates the row
  controls + shows a "system-managed" badge **off the API signal**, never a hardcoded client name. The
  engine's `getOrCreate()` additionally self-heals the row (un-revoke + re-enable) on next use as defence
  in depth.
- **Follow-ups.**
  - ~~**Frontend admin UI** for `/service-accounts`~~ — **delivered** as `/settings/service-accounts`
    (create/list/rotate/edit/revoke/restore; the token is shown once on create/rotate and is never
    refetchable; gated on `settings:manage`).
  - **Optional Zitadel machine-user mirror** (a future ADR) — the `IdentityProvider` seam stays open;
    BYOI no-ops, so nothing here depends on it.
  - Possible later: scoped/expiring tokens with a rotation reminder, per-token rate limits.

---

Related: [[0040-rbac-roles]] · [[0043-zitadel-source-of-truth]] · [[0046-roles-permissions-v2]] ·
[[0038-jit-user-provisioning]] · [[0041-soft-delete-reuse-and-restore]] · [[0005-id-strategy]] ·
[[0006-soft-delete-and-auditing]] · [[INVARIANTS]] · [[_MOC]]
