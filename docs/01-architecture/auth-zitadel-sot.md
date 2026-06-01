---
title: "Auth — Zitadel as source of truth (Option B): design dossier"
tags: [architecture, auth, authz, oidc, rbac, idp, zitadel, security, devops, frontend]
status: proposed
created: 2026-06-01
updated: 2026-06-01
---

# Auth — Zitadel as the identity & authorization source of truth (design dossier)

> **Decision of record:** [[0043-zitadel-source-of-truth]] (status: proposed). This dossier is the
> *how* behind that ADR — it consolidates six design lanes (Zitadel platform capabilities, backend
> auth, data model, devops/infra, frontend setup wizard, security) plus the UX direction, with
> concrete contracts, DDL, compose snippets, and a sequenced, migration-safe implementation roadmap.

The CEO chose **Option B**: Zitadel is the source of truth for identity + roles + tokens; lazyit can
manage users/roles by **writing back** to Zitadel; first-run is an **in-app setup wizard** (one build,
one run); app-created users **default to VIEWER**; BYOI remains an **optional, gracefully-degrading**
adapter.

---

## 0. Table of contents

1. [Zitadel platform capabilities](#1-zitadel-platform-capabilities)
2. [Backend auth design (IdentityProvider adapter + write-back)](#2-backend-auth-design)
3. [Data model evolution](#3-data-model-evolution)
4. [DevOps / infra — zero-touch bootstrap](#4-devops--infra--zero-touch-bootstrap)
5. [Frontend — first-run setup wizard + user management](#5-frontend--first-run-setup-wizard)
6. [Security — threat model & guardrails](#6-security--threat-model--guardrails)
7. [UI direction (from the UX lanes)](#7-ui-direction-from-the-ux-lanes)
8. [Implementation roadmap (sequenced, migration-safe)](#8-implementation-roadmap)

---

## 1. Zitadel platform capabilities

**Pinned version:** Zitadel `v2.68.0` (digest-pinned in `infra/docker-compose.prod.yml`). The runtime
authN path speaks **generic OIDC** (no Zitadel SDK) — only the *write-back* + *bootstrap* paths use
Zitadel-specific Management APIs. v2 (resource-based) APIs are used for all new integrations.

### 1a. Management API surface (v2, recommended)

| Operation | Endpoint | Used by |
| --- | --- | --- |
| Create human user | `POST /v2/users/human` | `idp.createUser` (`POST /users`) |
| Update user | `PATCH /v2/users/{userId}` | profile sync (future) |
| Deactivate (offboard) | `POST /v2/users/{userId}:deactivate` | `idp.deactivateUser` (offboard) |
| Reactivate | `POST /v2/users/{userId}:reactivate` | restore (future) |
| Grant project role | `POST /v2/users/{userId}/grants` | `idp.grantRole` (role change) |
| Revoke grant | `DELETE /v2/users/{userId}/grants/{grantId}` | `idp.revokeRole` |
| List grants | `GET /v2/users/{userId}/grants` | reconciliation (future) |
| List/create project roles | `GET`/`POST /v2/projects/{projectId}/roles` | bootstrap (define ADMIN/MEMBER/VIEWER) |

### 1b. Service-account authentication

Two options to authenticate lazyit → Management API; both request a token from `/oauth/v2/token` with
scope `urn:zitadel:iam:org:project:id:zitadel:aud`:

- **Private-Key JWT** (RS256, grant `urn:ietf:params:oauth:grant-type:jwt-bearer`, RFC 7523) —
  production-grade, rotatable. **Preferred for the runtime API → Management traffic.**
- **Personal Access Token (PAT)** — opaque bearer, simplest. **Used by the zero-touch bootstrap
  sidecar** (exported by `start-from-init`); rotate every 30 days.

### 1c. Role assertion into tokens (optional, provenance-only)

To surface roles *in the token* (informational only — never an authZ source, see §6): enable
**project-level** *"Assert Roles on Authentication"* **and** **app-level** *"User Roles Inside ID
Token"*. The claim shape is the nested
`urn:zitadel:iam:org:project:{projectId}:roles` object (a flat list is possible via Zitadel Actions
v2.22.0+). lazyit reads it only to display a "synced with IdP" provenance hint.

### 1d. FirstInstance / zero-touch bootstrap

`start-from-init` on first boot: initializes the DB schema, creates the first admin
(`ZITADEL_FIRSTINSTANCE_ORG_HUMAN_*`), and — when configured — a **machine user**
(`ZITADEL_FIRSTINSTANCE_ORG_MACHINE_*`) whose PAT/key is written to a mounted path
(`ZITADEL_FIRSTINSTANCE_PATPATH`). Idempotent on subsequent boots. `ZITADEL_MASTERKEY` (≥32 chars) is
set before first boot and **cannot change** afterward (lost key = lost encrypted data).

### 1e. Self-hosting gotchas (carried from the platform lane)

- `ZITADEL_EXTERNALDOMAIN` / `ZITADEL_EXTERNALPORT` must match the externally-advertised URL or you get
  *"Instance not found"* 404s. lazyit's Caddy already reverse-proxies `auth.{LAZYIT_DOMAIN}` →
  `zitadel:8080` (ADR-0037 §4).
- Token type must be **JWT** (not opaque Bearer) for the guard to validate it.
- Docker split-DNS: the API reaches the IdP at an internal URL; the guard already rewrites JWKS +
  userinfo to the internal origin and injects `X-Forwarded-Host`/`-Proto` (ADR-0038). The bootstrap
  sidecar must do the same for Management-API calls.
- Zitadel needs ~30–90s to first-init; healthcheck `start_period: 60s`.

---

## 2. Backend auth design

### 2a. The `IdentityProvider` adapter

A single interface abstracts the IdP, selected by `IDENTITY_PROVIDER_TYPE` (`zitadel` |
`generic-oidc`, default `zitadel`). New files under `apps/api/src/idp/`:

```ts
// apps/api/src/idp/identity-provider.interface.ts
export interface IdentityProvider {
  // AuthN: validate & extract identity from a JWT (generic OIDC; unchanged behaviour)
  validateToken(token: string): Promise<{ sub: string; email?: string; name?: string }>;
  // Roles: resolve a role from token claims (PROVENANCE only; never the authZ source — see §6)
  rolesFromToken(token: string): Promise<Role | null>;
  // User lifecycle write-back (Zitadel only; no-op + warn for BYOI)
  createUser(email: string, firstName: string, lastName: string, role: Role): Promise<{ externalId: string }>;
  deactivateUser(externalId: string): Promise<void>;
  grantRole(externalId: string, role: Role): Promise<void>;
  revokeRole(externalId: string): Promise<void>;
}
```

- **`ZitadelIdentityProvider`** (`apps/api/src/idp/zitadel-management.service.ts`) — implements all
  methods; caches a service-account token with auto-refresh; calls the v2 Management API (§1a).
- **`GenericOidcIdentityProvider`** (`apps/api/src/idp/generic-oidc-identity-provider.ts`) — validates
  tokens + reads an optional roles claim; all *management* methods log `warn` and return
  `{ externalId: sub }` / `void` (no-op). This is the BYOI graceful-degradation path.

Registered in `AuthModule` via a factory keyed on `IDENTITY_PROVIDER_TYPE`. The guards depend on the
interface, not the concrete class, so swapping the IdP is one env var.

### 2b. Authorization stays DB-first (recommended Fork #1 = A)

`RolesGuard` is **unchanged**: it reads `request.user.role` resolved from the local `User` row.
`JwtAuthGuard` sets `request.user` from the DB (by `externalId`), exactly as today. The token's role
claim, if any, is set onto `request.user.roleSource` as provenance and **logged at `warn` on
mismatch** — it never participates in the allow/deny decision.

> If the CEO selects Fork #1 (B) (token-authoritative), `JwtAuthGuard` would call
> `idp.rolesFromToken(token)` and set `request.user.role` from it, falling back to the DB row when the
> claim is absent (`roleSource='fallback'`). This dossier documents both; **the ADR's default is (A)**.

### 2c. Write-back wiring (Users controller / service)

ADMIN-gated (ADR-0040) `UsersService` methods call the injected `IdentityProvider`:

```ts
// create — DEFAULT VIEWER (CEO directive), then mirror to the IdP
async create(data: CreateUser): Promise<User> {
  const role = data.role ?? Role.VIEWER;            // was MEMBER → now VIEWER
  const user = await this.prisma.user.create({ data: { ...data, role, isActive: true } });
  await this.idp.createUser(data.email, data.firstName, data.lastName, role); // no-op for BYOI
  return user;
}

// role change — mirror the new grant to the IdP (last-admin + no-self-role guards still apply)
async update(id, data, actorId) {
  const current = await this.findOne(id);
  const updated = await this.prisma.user.update({ where: { id }, data });
  if (data.role && data.role !== current.role && current.externalId)
    await this.idp.grantRole(current.externalId, data.role);                  // no-op for BYOI
  return updated;
}

// offboard — deactivate in the IdP INSIDE the transaction so a failure rolls everything back
async remove(id, actorId) {
  const target = await this.findOne(id);
  return this.prisma.$transaction(async () => {
    if (target.externalId) await this.idp.deactivateUser(target.externalId);  // throws → rollback
    /* revoke grants + release assignments + soft-delete (unchanged) */
  });
}
```

A Management-API failure surfaces as **503** (no silent partial write). Every write-back is audited in
lazyit (`actor`, `operation`, subject, fields).

### 2d. New env surface (backend)

```
IDENTITY_PROVIDER_TYPE=zitadel        # | generic-oidc  (default zitadel)
ZITADEL_MGMT_API_URL=http://zitadel:8080   # internal Management base
ZITADEL_MGMT_AUTH=private-key-jwt     # | pat
ZITADEL_MGMT_KEY_PATH=/zitadel-secrets/api.json   # Private-Key JWT, or:
ZITADEL_MGMT_PAT_PATH=/zitadel-secrets/pat.txt    # PAT fallback
```

All credential paths are **mounted secret files**, never inline env values (§6.5). Boot-config
*warns* (does not fail) if the Management credential is absent — login must never be blocked by a
missing write-back capability.

---

## 3. Data model evolution

### 3a. DEFAULT VIEWER flip (Phase-1, single migration)

```prisma
// apps/api/prisma/schema.prisma — User
role Role @default(VIEWER)   // was @default(MEMBER) (ADR-0040)
```

```sql
-- migration: change_role_default_viewer
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'VIEWER';
```

- **Only affects new inserts.** Existing rows keep their current role (no backfill).
- **First-user-ADMIN unchanged** — the JIT count-then-create still sets ADMIN on an empty DB,
  overriding the VIEWER default (explicit > implicit).
- **Seed unchanged** — `seed.ts` sets `role: 'ADMIN'` explicitly, unaffected by the column default.
- Backend `UsersService.create` defaults an omitted role to `VIEWER` (§2c); `CreateUserSchema.role`
  stays `.optional()` in `@lazyit/shared`.

### 3b. `User.role` and `User.externalId` (retained, unchanged shape)

- **`role`** stays the authorization fast-path the `RolesGuard` reads (Fork #1 = A). Not bi-directionally
  synced; lazyit writes *to* Zitadel (one-way mirror, §2c). Optional `roleSource: 'token' | 'fallback'`
  may be added to the `User` response schema for UI provenance — additive, not breaking.
- **`externalId`** stays **full `@unique`** (NOT partial): it is the JIT upsert key and the
  offboarding stick (soft-deleted rows keep `externalId`; a returning `sub` 403s rather than
  resurrecting). Making it partial would break the upsert and re-open account-resurrection. This is a
  deliberate carry-over from ADR-0038/0041 — **do not change it**.

### 3c. Optional `ConfigSetting` table (for the wizard)

The setup wizard needs a once-only flag. Either compute `isConfigured` from "any ADMIN exists" (no new
table) or add a tiny key/value table:

```sql
CREATE TABLE config_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
);
-- e.g. key='setup_completed' value='<ISO ts>'
```

**Recommendation:** compute `isConfigured` from the ADMIN count for v1 (no new table); add
`ConfigSetting` only if a durable setup timestamp / future settings are wanted. The roadmap treats the
table as *optional* and, if adopted, it rides the same serial migration lane.

### 3d. Recent-activity view — separate track (PR #86)

The dashboard recent-activity feature (materialized view unioning AssetHistory / AssetAssignment /
AccessGrant / ConsumableMovement, read via `$queryRaw`, cursor-paginated) is **already in flight as
PR #86** (`feat/dashboard-recent-activity-view`) and is **independent of this auth epic**. It is *not*
re-specified here. The only coupling is migration ordering (§8): PR #86's view migration must land
**before** any `User`-touching migration in this epic so the single serial lane stays clean.

---

## 4. DevOps / infra — zero-touch bootstrap

Goal: `docker compose up` brings the full OIDC stack live with **zero Zitadel console access**.

### 4a. FirstInstance service account + PAT export

```yaml
# infra/docker-compose.prod.yml — zitadel service (added env)
zitadel:
  environment:
    ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME: zitadel-bootstrap
    ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME: "lazyit Bootstrap Service Account"
    ZITADEL_FIRSTINSTANCE_PATPATH: /zitadel-secrets/pat.txt
    ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE: "9999-12-31T23:59:59Z"
  volumes:
    - zitadel_secrets:/zitadel-secrets    # Zitadel WRITES the PAT here
```

### 4b. `zitadel-bootstrap` sidecar (one-shot, fail-loud)

```yaml
zitadel-bootstrap:
  build: { context: .., dockerfile: infra/docker/zitadel-bootstrap.Dockerfile }
  restart: "no"                            # one-shot; operator sees failures
  env_file: [env/.env.prod]
  volumes: [ zitadel_secrets:/zitadel-secrets ]   # read PAT, write oidc-client.json
  depends_on: { zitadel: { condition: service_healthy } }
  networks: [internal]
```

The sidecar waits for `/debug/healthz`, reads the PAT, **upserts** the `lazyit` project + OIDC web app
(redirect `…/api/auth/callback/oidc`, JWT token type, userinfo-in-ID-token, roles assertion), and
writes `/zitadel-secrets/oidc-client.json`:

```json
{ "OIDC_CLIENT_ID": "…@lazyit", "OIDC_CLIENT_SECRET": "…",
  "OIDC_JWKS_URI": "http://zitadel:8080/oauth/v2/keys",
  "OIDC_ISSUER": "https://auth.<domain>" }
```

### 4c. api / web read credentials at startup

```yaml
api:
  depends_on:
    db: { condition: service_healthy }
    migrate: { condition: service_completed_successfully }
    zitadel-bootstrap: { condition: service_completed_successfully }   # NEW
  volumes: [ zitadel_secrets:/zitadel-secrets:ro ]                     # read-only
web:
  depends_on:
    zitadel-bootstrap: { condition: service_completed_successfully }   # NEW
  volumes: [ zitadel_secrets:/zitadel-secrets:ro ]
```

The api reads `oidc-client.json` if `OIDC_CLIENT_*` are not already set in env. Boot-config validation
still enforces `OIDC_*` presence in OIDC mode, so a missing file is caught early.

### 4d. Dependency / health ordering

```
zitadel_db (healthy) → zitadel (healthy) → zitadel-bootstrap (completed) → api + web (healthy) → caddy
```

### 4e. Operator gotchas (carried from the devops lane)

- **Secrets volume must be writable by the zitadel uid** or the PAT silently fails to export → api 401
  at runtime.
- **`down -v` wipes `zitadel_db_data` but NOT host secret dirs.** For a clean re-bootstrap the operator
  must also remove the `zitadel_secrets` volume (or the host `./zitadel-secrets/`), else stale creds
  block re-provision. **Document this explicitly.**
- **The bootstrap is idempotent** (upsert) — `down && up` is safe; the sidecar logs loudly if it is
  updating an existing app rather than creating one.
- **BYOI:** the operator removes `zitadel`/`zitadel_db`/`zitadel-bootstrap`, sets the three `OIDC_*`
  (and `AUTH_*`) env vars, and brings up `api`/`web`/`caddy`. No sidecar, no Management API.

---

## 5. Frontend — first-run setup wizard + user management

### 5a. Detection endpoint

```
GET /config/status   @Public()
→ { isConfigured: boolean, adminCount: number, integrationMode: 'zitadel' | 'byoi' }
```

`isConfigured = adminCount > 0`. `integrationMode` is inferred from env (bundled Zitadel issuer vs.
external). Public so the wizard can poll it before any login exists.

### 5b. Setup endpoint

```
POST /config/setup   @Roles('ADMIN')   X-Idempotency-Key: <uuid>
body: { adminEmail, adminFirstName, adminLastName, zitadelConfig?: {…} }
→ 200 { success, message, setupCompletedAt }
   409 already configured · 403 not ADMIN · 400 validation
```

Idempotency-gated on "any ADMIN exists"; CSRF token required; rate-limited (security §6.3). Creates the
first ADMIN local row (and, if `integrationMode='zitadel'` and a Management credential is present,
mirrors to Zitadel). **Per Fork #2, the recommendation is wizard = first-ADMIN-only**; the heavy
Zitadel plumbing (project/app) is the sidecar's job.

### 5c. Wizard route + flow (Next.js 16 App Router)

`apps/web/app/(app)/setup/page.tsx` — full-screen, no sidebar. On mount it reads `GET /config/status`;
`isConfigured` → redirect `/dashboard`; else show the 4-step wizard:

1. **Welcome + integration choice** — radio: *bundled Zitadel* | *I have my own OIDC provider (BYOI)*.
2. **Zitadel config** (only if bundled) — link to the console + optional client id/secret inputs;
   **skippable** because the sidecar already provisioned them.
3. **Create first ADMIN** — email + first/last name (role fixed to ADMIN here, by definition).
4. **Confirm + redirect** — invalidate `GET /users/me` so the new ADMIN role is picked up.

Data layer per [[0020-frontend-data-layer]] (endpoints → hooks → components):
`lib/api/endpoints/config.ts` (`getConfigStatus`, `setupConfig`) → `lib/api/hooks/use-config.ts`
(`useConfigStatus`, `useSetupConfig`) → the wizard component. Heroicons in app code.

### 5d. User management (mostly already shipped, ADR-0040 Round-3)

The Users panel already renders roles and lets an ADMIN change them via `UserRoleSelect`, reading the
caller's role from `GET /users/me` (**never the token** — matches §6.1). This epic adds:

- **Default VIEWER** surfaced in the create dialog (role selector defaults to VIEWER).
- **BYOI graceful-degradation banner** on the Users page when the IdP emits no role claim / write-back
  is disabled: *"Role changes are managed locally and not synced to your IdP."*
- **(Optional, future)** soft-delete restore flow + a config-summary card (admin/member/viewer counts,
  default role, setup date). Deferred per the lanes.

### 5e. Routes summary

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/config/status` | GET | `@Public()` | first-run detection |
| `/config/setup` | POST | `@Roles('ADMIN')` + idempotency | create first ADMIN, mark configured |
| `/users/me` | GET | any auth | caller + role (UI gating; never the token) |
| `/users` | POST | `@Roles('ADMIN')` | create user (**default VIEWER**) + IdP write-back |
| `/users/:id` | PATCH | `@Roles('ADMIN')` | update incl. role; last-admin + no-self guards; write-back |
| `/users/:id` (offboard) | DELETE | `@Roles('ADMIN')` | soft-delete + IdP deactivate (in txn) |

---

## 6. Security — threat model & guardrails

The full threat model identified six surfaces; the guardrails below are **conditions of acceptance**
encoded in [[0043-zitadel-source-of-truth]] §6. Summary:

| # | Surface | Guardrail |
| --- | --- | --- |
| 6.1 | **Role-claim integrity** | Authorization re-reads `User.role` from the DB on every protected route; token role claims are provenance-only; log `warn` on mismatch (possible spoofing/drift). RS256 pinned. |
| 6.2 | **Service-account / PAT** | Generated in Zitadel (never in code), mounted as a secret file, scoped narrowly, rotated every 30 days (prefer Private-Key JWT at runtime); all Management-API calls audited in lazyit. |
| 6.3 | **Setup wizard** | One-time idempotency gate (any ADMIN exists → 409); CSRF token on POST; rate-limit; audit every admin creation; public-but-logged. |
| 6.4 | **BYOI degradation** | Management API is setup/write-back only — never on the runtime authN path; a missing/invalid Management credential **warns**, never blocks login; shim mode forbidden when `NODE_ENV=production`. |
| 6.5 | **Account linking by email** | Unchanged from ADR-0038: claim only `externalId IS NULL` *live* rows; never re-bind a different `sub` (409); soft-deleted rows invisible. Confirmed safe under the trusted-IdP assumption. |
| 6.6 | **Secrets in compose** | `ZITADEL_MASTERKEY` / `OIDC_CLIENT_SECRET` / Management PAT-key mounted as files (`/run/secrets/…` or `zitadel_secrets`), `.env.prod` `chmod 600` + gitignored; `down -v` paired with removing the secrets volume. |

A new security-invariants note (`docs/06-security/INVARIANTS.md`) is recommended to make 6.1/6.5 the
canonical non-negotiables; it rides the security lane, not this PR.

---

## 7. UI direction (from the UX lanes)

The wizard and user-management surfaces ride lazyit's broader UX northstar (functional → product). The
points that bind *this* epic:

- **Setup wizard UX** — full-screen 4-step flow (§5c), no sidebar; clear *bundled vs. BYOI* fork at
  step 1; the Zitadel step is skippable (sidecar already did the plumbing); confirmation invalidates
  `GET /users/me` so the new ADMIN's controls light up immediately.
- **Role visibility & gating** — the UI reads the caller's role from `GET /users/me` (never the OIDC
  token), mirroring the backend's DB-first rule (§6.1). The role selector defaults to **VIEWER** on
  create.
- **Unified `StatusBadge` vocabulary** — extend the planned shared badge system with a *role* badge
  (ADMIN/MEMBER/VIEWER) and an *IdP-sync provenance* indicator (`token` vs `fallback`/local), using the
  locked semantic palette (emerald/amber/sky/rose/gray/indigo) so the same hue means the same thing
  across entities.
- **BYOI graceful-degradation banner** — on the Users page, when the IdP emits no role claim and
  write-back is disabled, show a non-blocking banner explaining that roles are managed locally and not
  synced; surface 409/403 guard messages verbatim as toasts (already the Round-3 pattern).
- **Phasing** — the broader UX northstar (spacing/type/badge system, filter persistence, breadcrumbs,
  cross-links, keyboard/bulk power-user features) is a *separate* roadmap; only the wizard + role
  surfaces above are in scope for this epic. They are designed to *not* block the northstar's Phase 1
  (the StatusBadge contract is shared).

---

## 8. Implementation roadmap

**Sequenced, migration-safe.** PR-per-step; the user reviews and merges each into `dev` before the next
(worktree agents cut from current `dev`). **One serial migration lane** — no parallel migrations. Each
phase names the owning agent lane.

### Single serial migration lane (the only ordering that matters)

```
M0  (PR #86, independent)  add recent-activity materialized view        ← lands FIRST (no User touch)
M1  change_role_default_viewer   ALTER users.role SET DEFAULT 'VIEWER'   ← Phase 1, this epic
M2  (optional) add_config_settings   CREATE TABLE config_settings        ← Phase 3, only if adopted
```

> **Why M0 first:** PR #86 is unrelated but touches the same DB. Landing its view migration before any
> `User`-touching migration here keeps the lane linear and avoids a Prisma drift/merge tangle. If #86
> merges after M1, re-run `prisma migrate status` and resolve serially — never parallelize.

### Phase 1 — Foundation: DEFAULT VIEWER + adapter scaffold *(owner: backend-auth + data-model)*

- **PR 1.1 (data-model):** `change_role_default_viewer` migration + `User.role @default(VIEWER)` +
  `prisma generate`. Backend `UsersService.create` defaults omitted role → VIEWER. Spec coverage:
  new app-create = VIEWER; first JIT (empty DB) = ADMIN; existing rows unchanged; seed = ADMIN.
  **This is the DEFAULT VIEWER flip the ADR mandates in Phase 1.**
- **PR 1.2 (backend-auth):** `IdentityProvider` interface + `GenericOidcIdentityProvider` (no-op
  management) + `AuthModule` factory keyed on `IDENTITY_PROVIDER_TYPE`. Guards depend on the interface.
  No behaviour change yet (Zitadel adapter is a stub returning `{ externalId: sub }`); pure scaffolding,
  fully BYOI-safe. **Depends on:** nothing.
- **PR 1.3 (shared):** add optional `roleSource` to the `User` response schema (additive) +
  reaffirm `CreateUserSchema.role` optional. **Depends on:** none (shared is a leaf).

### Phase 2 — Write-back: Zitadel adapter + Management wiring *(owner: backend-auth)*

- **PR 2.1:** `ZitadelIdentityProvider` (`zitadel-management.service.ts`) — service-account token
  caching, v2 Management calls (create/grant/revoke/deactivate), internal-origin rewrite +
  `X-Forwarded-*` (mirror ADR-0038). Unit tests mock the HTTP layer. **Depends on:** 1.2.
- **PR 2.2:** wire write-back into `UsersService` (create → `createUser`; role change → `grantRole`;
  offboard → `deactivateUser` **inside the txn**); 503 on Management failure; audit every call.
  **Depends on:** 2.1. New env: `ZITADEL_MGMT_*` (§2d) + `.env.example`.

### Phase 3 — Zero-touch bootstrap + setup wizard *(owner: devops-infra + frontend)*

- **PR 3.1 (devops):** `infra/docker/zitadel-bootstrap.Dockerfile` + `infra/scripts/zitadel-bootstrap.sh`
  + `zitadel-bootstrap` service + `zitadel_secrets` volume + `depends_on` rewires + FirstInstance
  machine-user env + `.env.prod.example` updates + secret-file mounting. **Depends on:** 2.x (so api can
  consume Management creds), but the sidecar itself is independent of app code.
- **PR 3.2 (backend):** `ConfigModule` — `GET /config/status` (`@Public()`) + `POST /config/setup`
  (`@Roles('ADMIN')`, idempotency gate, CSRF, rate-limit, audit) + (optional) `config_settings` table
  (M2). **Depends on:** 1.x.
- **PR 3.3 (frontend):** `/setup` route + 4-step wizard + `config` endpoints/hooks (ADR-0020) + Users
  default-VIEWER selector + BYOI banner. **Depends on:** 3.2.

### Phase 4 — Hardening & docs *(owner: security + devops + each lane)*

- **PR 4.1 (security):** `docs/06-security/INVARIANTS.md` (the §6 non-negotiables) + setup-wizard
  CSRF/rate-limit/audit tests + role-claim mismatch logging test.
- **PR 4.2 (docs):** flip [[auth-bootstrap]] to lead with the zero-touch path (manual path retained as
  BYOI/fallback); update [[deploy-self-hosted]] + [[backups]] (secrets volume + masterkey) + the ADR
  MOC status (0043 proposed → accepted on CEO sign-off).

### Dependency graph (at a glance)

```
1.1 (VIEWER flip) ─┐
1.2 (adapter)  ────┼──► 2.1 (zitadel impl) ──► 2.2 (write-back wiring) ──► 3.1 (sidecar)
1.3 (shared)   ────┘                                                       3.2 (config api) ──► 3.3 (wizard UI)
                                                                           4.1 (security)  ┘
M0 (#86 view) ───────────────────────────── must precede M1 (in 1.1) ─────────────────────► 4.2 (docs)
```

### Lane ownership recap

| Lane (agent) | Owns |
| --- | --- |
| **data-model** | PR 1.1 (VIEWER flip + migration), M2 table if adopted |
| **backend-auth** | PR 1.2, 1.3 (shared), 2.1, 2.2, 3.2 (config API) |
| **devops-infra** | PR 3.1 (sidecar/compose/secrets), 4.2 deploy/backups runbooks |
| **frontend** | PR 3.3 (wizard + Users surfaces) |
| **security (sentinel)** | PR 4.1 (INVARIANTS + wizard/role tests) |
| **(independent)** | PR #86 recent-activity view — own track, M0 first |

Related: [[0043-zitadel-source-of-truth]] · [[0037-idp-choice-zitadel-byoi]] ·
[[0038-jit-user-provisioning]] · [[0039-authjs-v5-frontend-oidc]] · [[0040-rbac-roles]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0020-frontend-data-layer]] · [[auth-bootstrap]] ·
[[deploy-self-hosted]]
