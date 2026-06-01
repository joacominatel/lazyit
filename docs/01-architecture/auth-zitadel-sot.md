---
title: "Auth — Zitadel as source of truth (Option B): design dossier"
tags: [architecture, auth, authz, oidc, rbac, idp, zitadel, security, devops, frontend]
status: proposed
created: 2026-06-01
updated: 2026-06-01
---

# Auth — Zitadel as the identity & authorization source of truth (design dossier)

> **Decision of record:** [[0043-zitadel-source-of-truth]] (status: accepted — CEO approved all 7
> forks 2026-06-01). This dossier is the
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
9. [Compose structure (decided)](#9-compose-structure-decided)

---

## 1. Zitadel platform capabilities

**Pinned version:** Zitadel `v2.68.0` (digest-pinned in the canonical root `compose.yaml`). The runtime
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

> **Phase 2 — as built (binding env surface).** Phase 2 settled the runtime auth on the **Private-Key
> JWT** path only (decision #4; the PAT is the bootstrap sidecar's concern in Phase 3), so the
> `ZITADEL_MGMT_AUTH` / `…_PAT_PATH` draft vars above are *not* used at runtime. The implemented
> surface (see `apps/api/.env.example`):
>
> ```
> IDENTITY_PROVIDER_TYPE=zitadel            # | generic-oidc (default zitadel)
> ZITADEL_MGMT_PROJECT_ID=<projectId>       # the project whose ADMIN/MEMBER/VIEWER roles lazyit grants
> ZITADEL_MGMT_API_URL=http://zitadel:8080  # internal Management origin (defaults to OIDC_JWKS_URI / OIDC_ISSUER origin)
> ZITADEL_MGMT_SA_KEY=<inline JSON>         # the SA machine-key JSON, OR:
> ZITADEL_MGMT_SA_KEY_PATH=/zitadel-secrets/api-key.json   # a mounted secret file (Phase-3 sidecar; manual for now)
> ```
>
> The adapter + Management client live at **`apps/api/src/auth/identity/`** (the Phase-1 scaffold's
> home — `zitadel.identity-provider.ts` + `zitadel-management.service.ts`), not the draft `src/idp/`.
> The client reaches Zitadel at the internal origin with `X-Forwarded-Host`/`-Proto` derived from
> `OIDC_ISSUER` and signs the JWT-profile assertion with `aud = OIDC_ISSUER`, **mirroring
> `jwt-auth.guard.ts`**. The cached Management token is refreshed ~60s before expiry. The deactivate
> call is `POST /v2/users/{userId}/deactivate` (current v2; the older `:deactivate` colon form in §1a
> is equivalent). A missing/misconfigured credential **WARNs at boot-time resolution and throws a
> clear "Zitadel management not configured" 503 from the management methods only** — never on the
> login path. Write-back into `UsersService` is no-split-brain: create rolls back the local row if the
> mirror fails, a role change reverts the local role, and offboard runs `deactivateUser` **inside the
> offboard transaction** so a failure rolls the whole offboarding back — each surfacing **503**, and
> each audited via a structured Pino line (`op`, `actor`, `subjectUserId`, `fields`); no audit DB
> table this phase. Under `generic-oidc` every management call is a no-op, so a BYOI deployment writes
> the local user with **no Management call and no 503**.

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

> **Phase 3 — as built (binding).** PR 3.1 shipped the sidecar on the **Private-Key JWT** path (the
> §1b *preferred* mechanism), NOT the PAT draft in §4a/§4b below. The FirstInstance machine user
> exports a **JSON private key** (not a PAT) via the top-level `ZITADEL_FIRSTINSTANCE_MACHINEKEYPATH`
> (+ `…ORG_MACHINE_MACHINEKEY_TYPE: "1"`); the machine user is granted **IAM_OWNER**. The sidecar
> (`infra/scripts/zitadel-bootstrap.sh`, `alpine` + curl/jq/openssl) signs an RFC-7523 assertion with
> that key, exchanges it at `/oauth/v2/token`, and calls the **v1 Management API** (the `/management/v1`
> REST gateway — `POST /projects`, `/projects/{id}/apps/oidc`, `/projects/{id}/roles`, `/users/machine`,
> `/users/{id}/keys`) to idempotently create the project, the OIDC web app (Authorization Code,
> client-secret-basic, **JWT** access token, id-token userinfo + role assertion), the project roles
> **ADMIN/MEMBER/VIEWER** (Phase-2 `grantRole` prerequisite) and a runtime **service-account + key**.
> It writes **two** files: `oidc-client.json` (issuer/client_id/client_secret/jwks/project id) AND
> `sa-key.json` (the runtime SA private key for `ZITADEL_MGMT_SA_KEY_PATH`). Idempotency is
> search-first (`/projects/_search`, `/projects/{id}/apps/_search`, `/users/_search`) plus a
> short-circuit when both secret files already exist (the app secret can't be re-read). Fail-loud:
> `set -eu` + `restart: "no"`. Pinned to Zitadel **v2.68.0**.

### 4a. FirstInstance service account + PAT export (draft — superseded by the as-built note above)

```yaml
# compose.yaml — zitadel service (added env; lands with the sidecar PR)
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

The sidecar waits for `/debug/healthz`, authenticates (as built: Private-Key JWT, not a PAT),
**upserts** the `lazyit` project + OIDC web app (redirect `…/api/auth/callback/oidc`, JWT token type,
userinfo-in-ID-token, roles assertion) + the ADMIN/MEMBER/VIEWER roles + a runtime SA, and writes
`/zitadel-secrets/oidc-client.json` (consumed by api + web) plus `/zitadel-secrets/sa-key.json` (the
runtime SA key for `ZITADEL_MGMT_SA_KEY_PATH`):

```json
{ "OIDC_CLIENT_ID": "…@lazyit", "OIDC_CLIENT_SECRET": "…",
  "OIDC_JWKS_URI": "http://zitadel:8080/oauth/v2/keys",
  "OIDC_ISSUER": "https://auth.<domain>", "ZITADEL_MGMT_PROJECT_ID": "…" }
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

Both api and web **consume** `oidc-client.json` at startup (path = `OIDC_CLIENT_FILE`, default
`/zitadel-secrets/oidc-client.json`), filling whatever the operator left unset — explicit env **always
overrides** the file:

- **api** (`apps/api/src/auth/bootstrap-file.ts`, run from `main.ts` BEFORE boot-config validation):
  back-fills `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_JWKS_URI` /
  `ZITADEL_MGMT_PROJECT_ID` into `process.env`, so every downstream reader (`JwtAuthGuard`,
  `ZitadelManagementService`) is unchanged. Boot-config validation then sees the merged env, so
  OIDC-mode `OIDC_ISSUER`/`OIDC_JWKS_URI` presence is satisfied by the file in the bundled flow.
- **web** (`apps/web/lib/auth/bootstrap-file.ts`, run from `auth.ts`): maps the file's `OIDC_ISSUER` →
  `AUTH_ISSUER`, `OIDC_CLIENT_ID` → `AUTH_CLIENT_ID`, `OIDC_CLIENT_SECRET` → `AUTH_CLIENT_SECRET`, and
  the `OIDC_JWKS_URI` origin → `AUTH_INTERNAL_ISSUER`. Node-runtime-only (a no-op on the Edge
  middleware bundle and during `next build`, where the file is absent).

This is what makes the sidecar **zero-touch**: the project id + OIDC client id/secret are GENERATED at
first boot, so the operator cannot put them in env — they flow through the file. A missing file is the
normal BYOI / env-only path (silent no-op); the loaders never crash and never log secret values.
`ZITADEL_MGMT_PROJECT_ID` is no longer a required static env (it comes from the file); keep it set only
as a BYOI pin.

### 4d. Dependency / health ordering

```
zitadel_db (healthy) → zitadel (healthy) → zitadel-bootstrap (completed) → api + web (healthy) → caddy
```

### 4e. Operator gotchas (carried from the devops lane)

- **Secrets volume must be writable by the zitadel uid.** A freshly-created named volume is owned
  `root:root` (mode `0755`), but the `zitadel` container runs as a NON-ROOT user (uid ~1000), so
  `start-from-init` cannot write `bootstrap-key.json` (`permission denied`) → the `03_default_instance`
  migration fatals mid-way and the container restart-loops (`Errors.Instance.Domain.AlreadyExists`).
  **Resolved automatically:** a one-shot **`zitadel-secrets-init`** service (root, `restart:"no"`,
  `profiles:[prod]`) `chmod 0777`s `/zitadel-secrets` BEFORE Zitadel starts (`zitadel.depends_on`
  gates on it `service_completed_successfully`). No manual `chown`/`chmod` step.
- **Output files must be world-READABLE.** The sidecar (root) writes `oidc-client.json` + `sa-key.json`;
  `api`/`web` run as a DIFFERENT uid and mount `zitadel_secrets` READ-ONLY, so the sidecar `chmod 0644`s
  both outputs (a plain `umask` won't help — `mktemp` creates `0600` and `mv` preserves it). `0644` on an
  INTERNAL-only single-host volume is an accepted tradeoff; §6 "secrets as files" is still honored. The
  machine key stays `0600` (only root reads it).
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

> **Implemented (PR 3.2, ConfigModule).** The status payload carries the dev-posture flag and a CSRF
> token; `integrationMode` is `zitadel | generic-oidc` (the IdP factory's two values), not `byoi`.

```
GET /config/status   @Public()
→ {
    isConfigured: boolean,          // adminCount > 0 (derived, never a stored flag — no migration)
    adminCount: number,             // live ADMINs only (soft-delete-filtered)
    integrationMode: 'zitadel' | 'generic-oidc',  // from IDENTITY_PROVIDER_TYPE
    devMode: boolean,               // AUTH_MODE=shim || NODE_ENV!=production (topbar banner)
    csrfToken: string               // echoed on POST /config/setup (§5b)
  }
GET /config/csrf   @Public()  → { csrfToken }   // a standalone token without the full status
```

`isConfigured = adminCount > 0`. `integrationMode` / `devMode` are read from env. Public so the wizard
can poll it before any login exists. No secrets in the payload.

### 5b. Setup endpoint

> **Implemented (PR 3.2).** At first-run NO ADMIN (hence no session) exists, so the endpoint cannot be
> `@Roles('ADMIN')`-gated — it is **`@Public()`**, protected instead by Fork #7's three guards (the
> §6.3 "public-but-logged + rate-limited" posture). The CSRF token rides the `X-CSRF-Token` header
> (double-submit), not an `X-Idempotency-Key`. The role is locked to ADMIN (not client-settable).

```
POST /config/setup   @Public()   X-CSRF-Token: <token>
body: { email, firstName, lastName }     // role locked to ADMIN
→ 201 { success, adminId, email, mirrored, setupCompletedAt }
   409 already configured (any ADMIN exists — the one-time gate)
   403 invalid/missing CSRF token · 429 rate-limited · 400 validation
```

Guards: (1) the idempotent any-ADMIN gate (409 once configured), (2) a required CSRF token
(`SetupCsrfService`, stateless HMAC), (3) a per-IP rate limit (`SetupRateLimitGuard`). Every admin
creation is audited (structured Pino: op, email, ip). When `integrationMode='zitadel'` and a
Management credential is present the new ADMIN is mirrored into Zitadel (`mirrored: true`); a
Management failure **degrades to a local-only ADMIN** (`mirrored: false`, a warn is logged) rather
than hard-blocking first-run — the operator can repair Zitadel afterwards (per §6 #4).

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
| `/config/status` | GET | `@Public()` | first-run detection (+ devMode + a CSRF token) |
| `/config/csrf` | GET | `@Public()` | issue a standalone CSRF token for the setup POST |
| `/config/setup` | POST | `@Public()` + any-ADMIN gate + CSRF + rate-limit | create the first ADMIN |
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

### 7a. First-run Setup Wizard (auth/onboarding UX)

- **4-step full-screen flow** (§5c), no sidebar:
  1. **IdP choice** — radio fork: *bundled Zitadel* vs. *bring-your-own OIDC (BYOI)*.
  2. **Optional config** — only for BYOI (or to override the sidecar-provisioned bundled values); the
     bundled-Zitadel path can skip this step because the `zitadel-bootstrap` sidecar already did the
     plumbing.
  3. **Create first ADMIN** — email + first/last name; role is fixed to ADMIN here by definition.
  4. **Done** — confirmation; invalidates `GET /users/me` so the new ADMIN's controls light up
     immediately, then redirects to the dashboard.
- **First-run detection** — the wizard is driven by the public **`GET /setup/status`** endpoint
  (the `/config/status` of §5a; `{ isConfigured, adminCount, integrationMode }`): an unconfigured
  install (`isConfigured=false`, no ADMIN exists) routes to `/setup`; a configured install redirects
  straight to `/dashboard`. Polled before any login exists, so it must stay `@Public()`.
- **Configured-vs-dev-mode topbar banner** — a persistent topbar banner reflects the integration
  posture: a *dev / unconfigured* state (e.g. shim or no real IdP) shows a clearly-labelled warning
  banner; a *configured* state (real OIDC bound) shows the IdP it is wired to. This makes "am I running
  a real auth stack?" obvious at a glance and prevents shipping a dev posture by accident.

### 7b. Role-management UX

- **Role read from the DB, never the token** — the UI reads the caller's role from `GET /users/me`
  (never the OIDC token), mirroring the backend's DB-first rule (§6.1). The create-user role selector
  defaults to **VIEWER**.
- **Role-source badge** — a per-user *IdP-sync provenance* indicator (`token` / synced-with-IdP vs.
  `fallback` / local-only), part of the unified `StatusBadge` vocabulary alongside the *role* badge
  (ADMIN/MEMBER/VIEWER), using the locked semantic palette
  (emerald/amber/sky/rose/gray/indigo) so the same hue means the same thing across entities.
- **Last-admin guard surfaced** — the backend's last-admin-guard **409** (you cannot demote/offboard
  the final ADMIN) is surfaced as an **explained toast** (the guard message verbatim), not a raw error.
- **Self-role-change disabled** — an ADMIN cannot change their *own* role; the control is **disabled
  with an explanatory tooltip** rather than silently rejected, matching the backend no-self-role guard.
- **BYOI graceful-degradation banner** — on the Users page, when the IdP emits no role claim and
  write-back is disabled, a non-blocking banner explains that roles are managed locally and not synced;
  409/403 guard messages surface verbatim as toasts (already the Round-3 pattern).

### 7c. Phasing & north-star follow-up

- **Phasing** — the broader UX northstar (spacing/type/badge system, filter persistence, breadcrumbs,
  cross-links, keyboard/bulk power-user features) is a *separate* roadmap; only the wizard + role
  surfaces above are in scope for this epic. They are designed to *not* block the northstar's Phase 1
  (the StatusBadge contract is shared).
- **North-star follow-up (flagged).** The broader platform UI north-star here draws on the **Round-3
  UX audit**; the dedicated north-star analysis lane **did not return** for this dossier. Treat a
  consolidated platform UI north-star (built on the Round-3 audit) as a **small follow-up** to schedule
  separately — it does not gate this epic.

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
  - **Bundled sub-item — Compose consolidation (§9):** in the same PR, migrate to the canonical
    Compose v2 layout (`compose.yaml` + `compose.override.yaml` + a `prod` profile + a thin
    `infra/docker-compose.prod.yaml`), placing the `zitadel-bootstrap` sidecar in the `prod` profile.
    Backward-compatible (§9d). The three deferred sub-questions (§9e: secrets-volume persistence,
    `.env.prod` ownership, convenience alias) are settled here. **Owner: devops-infra.**
- **PR 3.2 (backend) — ✅ DONE:** `ConfigModule` — `GET /config/status` + `GET /config/csrf`
  (`@Public()`) + `POST /config/setup` (`@Public()` gated by the idempotent any-ADMIN check + a CSRF
  token + a per-IP rate limit + audit). NO `config_settings` table / migration — "configured" is
  derived from whether any ADMIN exists, integrationMode/devMode from env. The Management mirror on
  setup **degrades to local-only** (never hard-blocks first-run). **Depends on:** 1.x.
- **PR 3.3 (frontend) — ✅ DONE:** public `/setup` route (outside the `(app)` auth group) + the 4-step
  wizard + `config` endpoints/hooks (ADR-0020) + the dev-mode topbar banner + the Users-page BYOI
  graceful-degradation banner. **Depends on:** 3.2.

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

---

## 9. Compose structure (decided)

This resolves a CEO question raised alongside the auth epic: *how should the Compose files be
organized once the `zitadel-bootstrap` sidecar lands?* It is recorded here as **infra hygiene under
[[0025-containerization-strategy]] / [[0026-reverse-proxy-tls]] / [[0028-secrets-and-config]]** — there
is **no separate ADR**; it does not change a decision, it consolidates the existing split into the
canonical Compose v2 layout.

> **As built.** The consolidation landed first: `compose.yaml` + `compose.override.yaml` at the
> repo root and a thin `infra/docker-compose.prod.yaml`; the old `infra/docker-compose.prod.yml` was
> removed (backward-compat command aliased in [[deploy-self-hosted]]). The **`zitadel-bootstrap`
> sidecar then landed in PR 3.1** (Private-Key JWT, see the §4 as-built note): it lives in the `prod`
> profile, `depends_on: zitadel (service_healthy)`, mounts the `zitadel_secrets` volume read-write,
> and `api`/`web` gate on it via `service_completed_successfully`. The deferred sub-questions (§9e)
> are settled below.

### 9a. Target layout

- A single canonical **`compose.yaml` at the repo root** declaring **all** services (db, migrate, api,
  web, zitadel, zitadel_db, meilisearch, caddy, backup, and — once it lands — `zitadel-bootstrap`).
- A committed **`compose.override.yaml`** (auto-loaded by `docker compose` for dev tuning of the
  **unprofiled backing services only** — db, meilisearch, zitadel, zitadel_db): localhost-only port
  bindings (Postgres 5432, Meili 7700, Zitadel 8080), Zitadel `--tlsMode disabled`, no resource
  limits. The day-to-day developer experience: `docker compose up` brings up **just the backing
  services** (api/web run natively via `bun run dev`); Caddy is absent because it is prod-profiled.
- A **`prod` profile** inside `compose.yaml` gating the prod-only services (**api, web, migrate,
  Caddy**, the **backup sidecar**, and the future **`zitadel-bootstrap` sidecar**) so they never come
  up in plain dev.
- A **thin `infra/docker-compose.prod.yaml` override** carrying only the prod-specific deltas:
  env-file path (`infra/env/.env.prod`), the reserved `zitadel_secrets` volume mounts, internal-only
  networks, and the `lazyit-prod` project name (so prod volumes are namespaced and reused unchanged).

### 9b. Commands

```sh
# dev — auto-merges compose.override.yaml; no Caddy, localhost ports, no prod sidecars
docker compose up

# prod — explicit base + thin override + the prod profile + the prod env file
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build
```

### 9c. The `zitadel-bootstrap` sidecar in this layout

The one-shot `zitadel-bootstrap` sidecar (ADR-0043 §4 / dossier §4b) lives in the **`prod` profile**,
`depends_on: zitadel (condition: service_healthy)`, and writes the OIDC/AUTH secrets
(`oidc-client.json`) to a mounted **`zitadel_secrets` volume** that `api`/`web` read at startup
(dossier §4c). It is therefore absent from a plain `docker compose up` and only runs under
`--profile prod`.

### 9d. Migration path (backward-compatible) — DONE

1. **Renamed** `docker-compose.yml` → `compose.yaml` (root, via `git mv` to preserve history). ✅
2. **Created** `compose.override.yaml` with the dev tuning (localhost ports, Zitadel no-TLS, no
   limits) for the unprofiled backing services. ✅
3. **Merged** the prod-only services into `compose.yaml` with `profiles: [prod]` (api, web, migrate,
   Caddy, backup; slot reserved for `zitadel-bootstrap`); all prod hardening carried over verbatim
   (digest pins, `x-logging` anchor, `mem_limit`/`cpus`, healthchecks, `depends_on`). ✅
4. **Slimmed** `infra/docker-compose.prod.yml` → a **thin** `infra/docker-compose.prod.yaml` override
   (env-file path, `zitadel_secrets` volume, internal-only networks, `lazyit-prod` project name) and
   **removed** the old file — the bulk now lives in the canonical file. ✅
5. **Old runbook commands aliased**: the previous `-f infra/docker-compose.prod.yml` invocation maps
   to the new base + thin override + `--profile prod` + `--env-file`; documented in [[deploy-self-hosted]]
   and `infra/README.md`. ✅

Fully **backward-compatible**: dev gains zero-config `docker compose up` (backing services only), prod
keeps a single explicit command, the `lazyit-prod` project name (hence prod volumes) is unchanged, and
a rendered-config diff proves **no service or hardening option was dropped** (only the additive
`profiles:` markers + the reserved `zitadel_secrets` volume appear).

### 9e. Deferred implementation sub-questions — settled

1. **Secrets persistence** — the `zitadel_secrets` volume is a **persisted named volume** (creds
   survive `down`, faster restarts). A clean re-bootstrap pairs `down -v` with removing it (dossier
   §4e). It is declared in `infra/docker-compose.prod.yaml` now; the writer (the sidecar) is the next PR.
2. **`.env.prod` ownership** — `infra/env/.env.prod` stays an **operator-filled placeholder**
   (copied from `.env.prod.example`); the future sidecar writes the OIDC client values to the
   `zitadel_secrets` volume, NOT into `.env.prod`. No change to the existing secrets posture (ADR-0028).
3. **Convenience alias** — **kept explicit in the runbook** for now (no `Makefile`/`bun run` wrapper);
   the long prod command is documented verbatim. `bun run db:up`/`db:down` already wrap the **dev**
   `docker compose up -d` / `down` (now the backing-services stack).

Related: [[0043-zitadel-source-of-truth]] · [[0037-idp-choice-zitadel-byoi]] ·
[[0038-jit-user-provisioning]] · [[0039-authjs-v5-frontend-oidc]] · [[0040-rbac-roles]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0020-frontend-data-layer]] · [[auth-bootstrap]] ·
[[deploy-self-hosted]]
