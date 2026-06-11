---
title: "ADR-0043: Zitadel as the identity & authorization source of truth (Option B)"
tags: [adr, auth, authz, oidc, rbac, idp, zitadel, security]
status: accepted
created: 2026-06-01
updated: 2026-06-01
deciders: [Joaquín Minatel]
---

# ADR-0043: Zitadel as the identity & authorization source of truth (Option B)

## Status

**accepted** — 2026-06-01 (CEO approved all 7 forks with the recommended resolutions). This ADR **extends**
[[0037-idp-choice-zitadel-byoi]] (Zitadel is the bundled IdP + BYOI contract),
[[0038-jit-user-provisioning]] (JIT provisioning + account-linking) and
[[0040-rbac-roles]] (the local `Role` enum + `RolesGuard`). It does **not** discard them: the
trusted-IdP assumption, the `JwtAuthGuard`, the `RolesGuard`, the `@Roles()` mechanism and the
three-env-var BYOI envelope all survive. What changes is the **direction of authority and the
operator experience**: Zitadel becomes the source of truth that lazyit can *write back to*, roles
can be sourced *from the token*, and first-run becomes an **in-app setup wizard** (one build, one
run) instead of a manual console chore.

It supersedes the *defaults and follow-ups* of the prior auth ADRs as noted in
[§ What this supersedes](#what-this-supersedes) — it does not supersede the ADRs wholesale.

> The companion design dossier (contracts, DDL, compose, wizard UX, threat model, roadmap) lives at
> [[auth-zitadel-sot]]. This ADR records the *decision and its guardrails*; the dossier records *how*.

> [!success] Validated live — 2026-06-01 (epic delivered)
> The full epic was **validated end-to-end live** on 2026-06-01: a zero-touch first boot
> (`docker compose … --profile prod up -d --build` from an `.env.prod` with no hand-copied OIDC
> client) brings up the bundled Zitadel, provisions project/app/roles/SA via the sidecar, and the
> in-app `/setup` wizard creates the first ADMIN, who is mirrored (write-back) into Zitadel. Phase 4
> hardening landed the four as-built fixes the live debugging surfaced:
> - **#92** — the `zitadel-bootstrap` **sidecar** (Private-Key JWT) provisions project + OIDC app +
>   ADMIN/MEMBER/VIEWER roles + runtime SA, writing `oidc-client.json` / `sa-key.json` to the volume.
> - **#93** — the **`zitadel-secrets-init`** one-shot fixes the secrets-volume permissions (`chmod`
>   before Zitadel boots) so the non-root Zitadel uid can export its FirstInstance machine key.
> - **#94** — the **healthcheck gate**: the shell-less Zitadel image carries no container healthcheck,
>   so the sidecar gates on `service_started` and polls `/debug/healthz` itself before provisioning.
> - **#95** — the **v1 user-grant endpoints**: user-grant CRUD lives on `/management/v1/users/...`
>   (the v2 `/v2/users/{id}/grants` form 404s on Zitadel v2.68.0); `grantRole` is set-role.
>
> Also fixed: the `ZITADEL_MASTERKEY` must be **exactly 32 bytes** (not "min 32"); `openssl rand -hex
> 16` yields a correct value (see `infra/env/.env.prod.example` + [[auth-bootstrap]]). The §6
> guardrails are recorded as the canonical security non-negotiables in [[INVARIANTS]].

---

## Decisions (resolved 2026-06-01, CEO-approved)

The design lanes surfaced **seven forks** that gated the roadmap. On 2026-06-01 the CEO **approved all
seven with the recommended resolutions**. They are recorded here as the binding decisions; the design
dossier ([[auth-zitadel-sot]]) carries the implementation detail.

1. **Role authority = DB-first.** `RolesGuard` reads `User.role` from the **database**; a token role
   claim is **never an authorization source** (informational/diagnostic only). Roles are written *back*
   to Zitadel as a one-way mirror so the IdP console reflects reality, but a privilege decision never
   trusts a token claim. (Least surprise, BYOI-safe, no per-request token re-parse — and the security
   lane's hard invariant.)

2. **Setup wizard = split.** The infra `zitadel-bootstrap` sidecar does the zero-touch Zitadel plumbing
   (project + OIDC app + PAT export); the in-app wizard is the phase that **confirms the integration
   mode and creates the first ADMIN**. This keeps the wizard BYOI-safe (a BYOI operator skips the
   Zitadel step and still creates the first ADMIN).

3. **Default role = VIEWER, uniform.** App-created **and** non-first JIT users default to **VIEWER**
   (least privilege, uniform across both flows — this flips the JIT non-first default MEMBER→VIEWER).
   **The first user ever on an empty DB stays ADMIN** (an install must never be left un-administrable).

4. **Management-API auth = PAT + Private-Key JWT.** The bootstrap sidecar authenticates with a **PAT**
   (what `start-from-init` already exports); the runtime API → Management traffic uses a rotatable
   **Private-Key JWT** (production-grade). **Rotate the PAT every 30 days** and scope the service
   account as narrowly as Zitadel allows.

5. **BYOI = read-only role management.** With a generic OIDC IdP there is no Management API to write
   back to, so user/role *write-back* methods **no-op with a `warn` log + a UI banner**; BYOI keeps
   full authN + JIT + *local* RBAC. A generic write-back interface (SCIM / webhook) is a **deferred
   future ADR**.

6. **Existing-user migration = not a concern for now.** lazyit currently runs only on `dev`; the
   operator uses `docker compose down -v` for a clean slate, so **no bulk-sync ("local roles → Zitadel")
   script is built**. Existing rows keep their current role; only **new inserts** get the VIEWER default
   (DB-first authorization means a missing Zitadel role claim is harmless). **Revisit before any
   production deployment.**

7. **Setup-endpoint guards = idempotent gate + CSRF + rate-limit.** `POST /config/setup` is
   **idempotency-gated on "any ADMIN exists"** (returns 409 once one exists), requires a **CSRF token**,
   and is **rate-limited** and audited. It is **exposed on the reverse proxy** (so an operator can reach
   first-run remotely) but **logged + rate-limited**, not localhost-only.

---

## Context

The May–June 2026 auth arc landed authentication ([[0037-idp-choice-zitadel-byoi]],
[[0038-jit-user-provisioning]], [[0039-authjs-v5-frontend-oidc]]) and a minimal authorization layer
([[0040-rbac-roles]]). The result works end-to-end in prod compose (PR #58) but leaves three gaps the
CEO wants closed to move lazyit "from a functional tool to a product":

- **Identity is read-only from lazyit's side.** lazyit consumes the IdP (validates tokens, JIT-creates
  a local `User` mirror) but cannot *manage* users/roles in Zitadel. An admin who wants to onboard or
  offboard someone, or change a role, must do it twice (in lazyit *and* in the Zitadel console) or the
  two drift apart.
- **First run is a console chore.** ADR-0037 §6 + the [[auth-bootstrap]] runbook require an operator to
  open the Zitadel console, create the OIDC app, copy the client id/secret into `.env.prod`, and
  restart. The CEO wants **one build, one run**: bring the stack up and finish setup *inside the app*.
- **No least-privilege default for app-created users.** New users default to MEMBER (ADR-0040), which
  is a *writeable* role. The CEO wants app-created users to start **read-only (VIEWER)** and be
  explicitly promoted.

The CEO chose **Option B**: make **Zitadel the source of truth for identity + roles + tokens**, with
lazyit able to *manage* users/roles by **writing back to Zitadel**, an **in-app first-run setup
wizard**, and **DEFAULT VIEWER** for app-created users — while preserving BYOI as an optional,
gracefully-degrading adapter.

The constant constraint: the target operator is a 5–20-person IT team self-hosting via Docker Compose
([[0015-deployment-model]]). Anything that adds an irreversible foot-gun (lost master key, wedged
first-run, silent privilege escalation) is unacceptable.

## Considered options

- **Option A — keep the status quo (authN-only IdP, local RBAC, manual bootstrap).** Zero new code;
  the IdP stays a pure authN gate, roles stay purely local, the console chore remains. Rejected by the
  CEO: it leaves the three gaps above open and keeps onboarding/offboarding a two-place dance.

- **Option B — Zitadel as the identity & authorization source of truth (chosen).** lazyit drives the
  Zitadel **Management API** (v2, resource-based) to create/update/deactivate users and grant/revoke
  roles; an optional `project-role`/roles claim can flow into the token; first-run is an in-app wizard
  backed by a zero-touch `zitadel-bootstrap` sidecar; app-created users default to VIEWER. An
  **`IdentityProvider` adapter** abstracts the IdP so BYOI degrades gracefully (full authN + JIT +
  local RBAC; user/role *write-back* becomes a no-op-with-warning).

- **Option C — full Zitadel coupling, drop local RBAC, trust token roles for authZ.** Maximal
  source-of-truth purity: delete `User.role`, read roles from the token claim, manage everything in
  Zitadel. Rejected: it breaks BYOI (generic OIDC IdPs have no equivalent role API), couples
  authorization to a vendor-specific claim shape, and makes a forged/misconfigured token a privilege
  vector (the [[#security-guardrails|security lane]]'s hard "never trust token claims for authZ" rule).

## Decision

Adopt **Option B**. The shape, in nine parts:

### 1. Optional `IdentityProvider` adapter — Zitadel-by-default, BYOI-graceful

Introduce an `IdentityProvider` interface (backend) with two implementations selected by a single env
var `IDENTITY_PROVIDER_TYPE` (`zitadel` | `generic-oidc`, default `zitadel`):

- **`ZitadelIdentityProvider`** — full management: validates tokens (standard OIDC, unchanged),
  resolves roles from the token claim when present, and **writes back** to Zitadel's Management API
  (create user, deactivate user, grant/revoke role).
- **`GenericOidcIdentityProvider`** — BYOI minimal: validates tokens and reads a roles claim *if the
  IdP emits one*; all *management* methods (`createUser` / `deactivateUser` / `grantRole` /
  `revokeRole`) **no-op with a `warn` log**. Users are managed in the operator's IdP.

The runtime authentication path stays **generic OIDC** with no Zitadel SDK (the BYOI envelope of
ADR-0037 §3 is untouched). Management-API coupling is *opt-in* and lives only in the Zitadel adapter.

### 2. Roles: DB-first authorization, Zitadel as the write-back mirror

`RolesGuard` continues to read `request.user.role` resolved **from the local `User` row** (ADR-0040).
This is the **CEO-approved resolution of Fork #1 (DB-first)** and the security lane's non-negotiable
invariant:

> **Token claims are NOT an authorization source.** A role claim, if present, is informational/
> diagnostic only. Every privilege decision re-reads `User.role` from the database. A mismatch
> between a token's role claim and the DB row is logged at `warn` (possible spoofing/drift).

When an ADMIN changes a role in lazyit, the Zitadel adapter **mirrors** that change into the user's
Zitadel project-role grant (write-back), so the IdP console reflects reality. The optional
`project-role` claim (`urn:zitadel:iam:org:project:{projectId}:roles`, asserted via the project's
*"Assert Roles on Authentication"* + the app's *"User Roles Inside ID Token"* toggles) can be surfaced
in the UI as provenance, but never gates access.

*(Fork #1 was resolved DB-first; the token-authoritative variant was rejected. The dossier still
documents both wirings for reference, but this ADR mandates DB-first.)*

### 3. Management-API write-back for user & role lifecycle

The Zitadel adapter speaks the **v2 (resource-based) Management API** — `POST /v2/users/human`
(create), `POST /v2/users/{id}/grants` (grant role), `DELETE …/grants/{id}` (revoke),
`POST /v2/users/{id}:deactivate` (offboard) — authenticated by a dedicated **service account**.
Write-back is wired into the existing ADMIN-gated Users controller:

- `POST /users` → create local mirror (role **VIEWER**) **then** `idp.createUser(...)`.
- `PATCH /users/:id` (role change) → update local mirror **then** `idp.grantRole(...)`.
- `DELETE /users/:id` (offboard) → `idp.deactivateUser(externalId)` **inside the offboard transaction**
  so a Management-API failure rolls the whole offboard back (no soft-deleted-local / still-active-IdP
  split-brain).

A Management-API failure surfaces as **503** (not a silent partial write); all write-back calls are
recorded in lazyit's own audit trail (`actor='system'|admin`, `operation`, subject, fields).

> [!note] #196 — friendlier 503, transient retry (consistency model UNCHANGED)
> The 503's *presentation* was hardened in **issue #196** without touching this strong-coupling
> decision: the **public** message is now generic + actionable (no internal verb/path/upstream status
> leaks to the toast — the rich detail stays in the WARN log, correlated by request id, ADR-0031), and
> the Management client **retries a transient upstream failure** (network error or `408/429/5xx`) with a
> bounded backoff + jitter (≤3 attempts, total added latency capped ~1.8s, `Retry-After`-aware) so a
> brief blip is invisible while a *sustained* outage still hits the revert-and-503 path above. Permanent
> `4xx` and the token/auth fetch are not retried; the two non-idempotent writes (create-user, grant-ADD)
> single-shot to avoid a duplicate. The **queue/reconcile vs. strong-coupling consistency model** (issue
> #196 layer (c)) is **DEFERRED to a future CEO decision** — this ADR's strong-coupling contract stands.

> [!note] #219 — management WARN logs are now request-correlatable (diagnostic-enablement only)
> The #196 note above claimed the management WARN "correlated by request id" — but the management
> client logged via the static `@nestjs/common` `Logger`, so its lines did **not** carry the
> `X-Request-Id` echoed to the browser, leaving an operator unable to join a failing edit's 503 toast
> to its upstream cause. **Issue #219** closes that gap: the auth module injects the request-scoped
> `PinoLogger` (nestjs-pino) into the Zitadel management client, so every management WARN now rides the
> request's `X-Request-Id` / `actor` via AsyncLocalStorage (ADR-0031) and carries a **structured**
> `{ operation, method, path, upstreamStatus, reason }` shape. The SA token/key is still **never**
> logged (INV-6). This is **diagnostic-enablement only** — the friendly 503 message and the bounded
> retry from #196 are unchanged, and it makes the *sustained* `PUT /v2/users/human/{id}` 503
> root-causable against the live stack. The actual root-cause diagnosis (needs the running Zitadel) and
> the **#196 layer (c) consistency-model decision** both **remain open** for the CEO — see the DEFERRED
> note above; this ADR's strong-coupling contract still stands.

### 4. Zero-touch bootstrap + in-app setup wizard ("one build, one run")

Two cooperating pieces replace the console chore:

- **Infra (`zitadel-bootstrap` sidecar).** Zitadel `start-from-init` creates a machine user + PAT and
  exports it to a mounted `zitadel_secrets` volume (`ZITADEL_FIRSTINSTANCE_ORG_MACHINE_*` +
  `ZITADEL_FIRSTINSTANCE_PATPATH`). A one-shot sidecar then *upserts* the `lazyit` project + OIDC app
  via the Management API and writes `oidc-client.json` (client id/secret/jwks/issuer) to the same
  volume; api + web read it at startup. The sidecar **fails loud** (no restart policy) so a
  misconfiguration is visible. `api`/`web` `depends_on: zitadel-bootstrap (completed_successfully)`.
- **App (setup wizard).** A `GET /config/status` (`@Public()`) reports
  `{ isConfigured, adminCount, integrationMode }` (unconfigured = no ADMIN exists). A full-screen
  `/setup` route detects the unconfigured state, lets the operator pick **bundled Zitadel** or
  **BYOI**, and creates the **first ADMIN** via an idempotent `POST /config/setup` (gated by an
  "any-ADMIN-exists" flag, a CSRF token and a rate limit). Once an ADMIN exists the wizard
  self-locks and redirects to `/login` (the new ADMIN authenticates through the IdP first). A
  first-run gate in `apps/web/proxy.ts` routes a fresh, sessionless operator to `/setup`.

The wizard is **BYOI-safe**: a BYOI operator skips the Zitadel step (their `OIDC_*` env vars are
already set) and still creates the first ADMIN; the backend makes **zero** Management-API calls when
`integrationMode != 'zitadel'`.

> [!important] Update (issue #335) — the bundled `/setup` sets an INITIAL PASSWORD, and mirrors block.
> The bundled flow has **no SMTP** (and never will), so a Zitadel human user created with only a
> verified email and **no credential** lands in Zitadel's *initialize-by-emailed-code* state — the
> operator hits a "Set Password" screen whose code never arrives and is **locked out** (the original
> bug). Two refinements close this, scoped to the management path (`idp.supportsManagement`, i.e.
> bundled Zitadel):
> 1. **The wizard collects an initial password** (validated against Zitadel's default complexity
>    policy via the shared `SetupPasswordSchema`), and the backend sets it on the new Zitadel user
>    with `changeRequired:false`, so the operator can sign in **immediately** with email + password —
>    no email/code round-trip. `GET /config/status` advertises this with a derived
>    `requiresAdminPassword` flag (= `supportsManagement`); the wizard shows the password fields only
>    when it is true. This is a **deliberate, narrow carve-out** of the "lazyit never sets a password"
>    stance (ADR-0016/0037): it applies **only** to the bundled IdP — which IS lazyit's own — and
>    never to BYOI, where the operator's directory owns the credential and **no password is sent**.
> 2. **The management mirror now BLOCKS, not degrades.** The old DEGRADE-NOT-BLOCK (§6 #4) left a
>    *local-only* ADMIN on a mirror failure — but with a password-bearing bundled user that is exactly
>    the un-loggable state we are fixing, so on the management path a `createUser` failure now
>    **compensates** (hard-deletes the just-created local row) and surfaces a retry-able **503**,
>    creating nothing. DEGRADE-NOT-BLOCK still governs the **non-management** path (BYOI /
>    generic-OIDC), where there is no mirror to fail on and the local ADMIN is the whole story.

### 5. DEFAULT VIEWER for app-created users

The bootstrap default flips from MEMBER to **VIEWER** for app-created users (CEO directive):

- `CreateUserSchema` (`@lazyit/shared`) keeps `role` *optional*; the **backend** defaults an omitted
  role to **VIEWER** (not MEMBER).
- The Prisma `User.role` column default flips `@default(MEMBER)` → `@default(VIEWER)` (single migration,
  see the roadmap's serial lane). **Only affects new inserts**; existing rows keep their role.
- **First-user-ADMIN is unchanged**: on a truly empty DB the first JIT login / seed is still ADMIN
  (an install must never be left un-administrable).
- Per Fork #3 (CEO-approved), the *non-first JIT* default is also flipped MEMBER→VIEWER so the
  least-privilege default is **uniform across JIT and app-create**.

### 6. Security guardrails (encoded, non-negotiable)

From the security lane's threat model; these are conditions of acceptance:

1. **Roles are never trusted from token claims** — always re-validated from `User.role` (see §2).
2. **Account linking by email stays race-safe and never steals** — unchanged from ADR-0038; claim only
   `externalId IS NULL` *live* rows; never re-bind a different `sub`; soft-deleted rows invisible.
3. **First-run is idempotent + one-time gated** — `POST /config/setup` returns 409 once an ADMIN
   exists; CSRF token required; rate-limited; every admin creation audited.
4. **BYOI always degrades gracefully** — Management API is *setup/write-back only*, never on the
   runtime authN path; a misconfigured/absent Management credential never blocks login (boot-config
   *warns*, does not fail).
5. **Secrets are never plaintext-in-image** — `ZITADEL_MASTERKEY`, `OIDC_CLIENT_SECRET`, the
   Management PAT/key are mounted as files (`/run/secrets/…` or the `zitadel_secrets` volume), the
   `.env.prod` is `chmod 600` + gitignored, and `down -v` must be paired with removing the secrets
   volume for a clean re-bootstrap.
6. **The service-account credential is rotated** (PAT every 30 days; prefer Private-Key JWT at
   runtime) and **scoped as narrowly as Zitadel allows**; all Management-API calls are audited in
   lazyit.

### 7. Local `User` mirror is retained

The local `User` table stays (FKs for assignments/grants/authorship/history, audit timestamps, search
index, offline fallback). `User.role` remains the authorization fast-path (§2). It is a *directory
mirror + authorization cache*, not the identity authority — identity lives in the IdP (`externalId` =
`sub`, unchanged).

### 8. UI direction (from the UX lanes)

The wizard and user-management UI ride the broader UX northstar (see the dossier's
[UI direction](auth-zitadel-sot#ui-direction-from-the-ux-lanes) section): a 4-step full-screen wizard
(welcome/integration choice → optional Zitadel config → create first ADMIN → confirm), a unified
`StatusBadge` vocabulary (extended with a `roleSource` / IdP-synced indicator), role read from
`GET /users/me` (never the token, mirroring §2), and a **BYOI graceful-degradation banner** on the
Users page when the IdP emits no role claim and write-back is disabled.

### 9. Phased, migration-safe delivery

Implementation is sequenced into PR-sized phases owned by the existing agent lanes, with a **single
serial migration lane** (no parallel migrations). **Phase 1 includes the DEFAULT VIEWER flip.** The
in-flight dashboard recent-activity-view PR (**#86**, `feat/dashboard-recent-activity-view`) is
**independent** of this epic and lands on its own track; the roadmap notes the one ordering touch-point
(it must merge before any `User`-touching migration to keep the serial lane clean). Full breakdown in
[[auth-zitadel-sot]] § Implementation Roadmap.

## What this supersedes

This ADR **extends** rather than replaces ADR-0037/0038/0040. Specifically it supersedes:

- **ADR-0040's default-role decision** (`@default(MEMBER)` for app-created users) → **VIEWER** (§5).
- **ADR-0037 §6 + [[auth-bootstrap]]'s manual OIDC-client registration** as the *primary* path →
  the zero-touch sidecar + in-app wizard (§4). The manual runbook is retained as the BYOI / fallback
  path.
- **ADR-0038's "roles never sync to the IdP" posture** → roles are **written back** to Zitadel as a
  mirror (§3). The reverse (token role → authZ) is explicitly *not* adopted (§2).
- It leaves intact: the trusted-IdP assumption, JIT provisioning, account-linking-by-email,
  RS256-pinned validation, the `JwtAuthGuard`/`RolesGuard` ordering, and the three-env-var BYOI
  envelope.

## Consequences

- **Positive:**
  - One build, one run: an operator brings the stack up and finishes in-app — no console chore.
  - Onboarding/offboarding and role changes happen once, in lazyit, and mirror to Zitadel — no drift.
  - Least-privilege by default (VIEWER) for app-created users; first-user-ADMIN preserved.
  - BYOI still works with zero code changes; degradation is explicit and visible, not silent.
  - Authorization stays DB-first and vendor-neutral; a forged/misconfigured token cannot escalate.

- **Negative / trade-offs:**
  - New coupling surface (Management API) and a privileged service-account credential to secure and
    rotate; mitigated by §6 guardrails + audit.
  - BYOI loses *write-back* user/role management (read-only roles, manage in your IdP) — CEO-approved
    for v1 (Fork #5); a generic write-back interface is a deferred future ADR.
  - The setup wizard adds a privileged pre-login surface; mitigated by the idempotent one-time gate +
    CSRF + rate-limit (Fork #7).
  - `ZITADEL_MASTERKEY` remains the recovery linchpin (lost key = lost encrypted Zitadel data); the
    backup posture in [[backups]] / [[auth-bootstrap]] becomes more load-bearing.
  - **No existing-user migration is built** (Fork #6): lazyit runs only on `dev`, so the operator gets
    a clean slate with `docker compose down -v` — existing rows keep their role, only new inserts get
    the VIEWER default, and **no bulk role-sync script is shipped**. This is revisited before any
    production deployment.

- **Follow-ups (out of scope here, deferred to a future ADR):**
  - A generic write-back interface for BYOI (webhook / SCIM) — Fork #5 (B).
  - Periodic / event-driven *bidirectional* role sync (IdP-console role change → lazyit) — currently
    one-way (app → Zitadel).
  - Profile sync (name/email re-pull on login) — already deferred in ADR-0038.

Related: [[0037-idp-choice-zitadel-byoi]] · [[0038-jit-user-provisioning]] ·
[[0039-authjs-v5-frontend-oidc]] · [[0040-rbac-roles]] · [[0041-soft-delete-reuse-and-restore]] ·
[[auth-zitadel-sot]] · [[auth-bootstrap]] · [[deploy-self-hosted]] · [[user]]
