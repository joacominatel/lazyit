---
title: "ADR-0046: Roles & Permissions v2 — fixed roles, configurable permissions (catalog-as-code)"
tags: [adr, auth, authz, rbac, permissions, security]
status: accepted
created: 2026-06-02
updated: 2026-06-20
deciders: [Joaquín Minatel]
---

# ADR-0046: Roles & Permissions v2 — fixed roles, configurable permissions (catalog-as-code)

## Status

**accepted** — 2026-06-02 (CEO decision). This ADR **supersedes the authorization MECHANISM of**
[[0040-rbac-roles]] — the coarse `@Roles()` role-gate — with a fine-grained permission model, while
**keeping** ADR-0040's per-domain philosophy (authorization is per-domain, NEVER per-record / per-row
ACLs — Option B's per-resource matrix stays rejected). It **extends** [[0043-zitadel-source-of-truth]]
(DB-first authorization, IdP write-back, BYOI): permissions are a new DB-first authorization source
that, like roles, is never read from a token claim and never synced to the IdP.

> **Delivery status (2026-06-02):** P0–P7 are **delivered**. The foundation (P0+P1: catalog +
> `RolePermission` table + seed + golden test), the enforcement layer (P2: the `@RequirePermission`
> guard; P3: the GETs annotated + the two pre-tightened reads; P4: the `@Roles` write-gates migrated
> and the legacy `@Roles` decorator + dual-mode branch **retired**), the configurable surface (P5: the
> `GET/PUT /config/permissions` + `/config/my-permissions` endpoints, audited + cache-coherent, ADMIN
> immutable), the config UI (P7: the role-first ADMIN screen + `can()` infra) and the permission-aware
> UI gating (P6b: every `useCanWrite`/`isAdmin` write-gate migrated to `can('domain:action')`,
> `useCanWrite` retired) are all shipped. The coarse `@Roles` mechanism from [[0040-rbac-roles]] no
> longer exists in code — `@RequirePermission` is the SINGLE enforcement primitive. Still
> **outstanding**: the service-account fast-follow — see
> [§Phased delivery](#phased-delivery).

## Context

[[0040-rbac-roles]] closed the May-2026 "authN but no authZ" finding with a deliberately minimal
model: a single `Role` enum on `User` (`ADMIN`/`MEMBER`/`VIEWER`), a `@Roles()` decorator and a
`RolesGuard`. It explicitly **rejected** any per-resource permission matrix as over-engineering for a
5–20-person team. That was the right call to *close the hole fast*, but it left two limitations the CEO
now wants addressed:

- **The role→capability mapping is hard-coded in decorators.** "What a MEMBER may do" is spread across
  ~70 `@Roles(...)` annotations on controllers. There is no way to adjust a role's powers without
  editing and redeploying code, and no single place that states the full matrix.
- **Reads are wide open.** Every `GET` is unannotated, so any authenticated user — including VIEWER —
  can read **everything**, including the user directory and who-has-access-to-what. ADR-0040 accepted
  this ("read everything = all roles"); the CEO wants to start tightening the most sensitive reads.

The CEO's framing (quoted, do not re-litigate):

- **"3 roles fijos + permisos configurables."** Keep `enum Role { ADMIN MEMBER VIEWER }` exactly
  as-is; make the per-role PERMISSIONS configurable. This is **not** dynamic custom roles (deferred to
  a future ADR).
- **"Pre-tightening de los 2 reads sensibles."** Every `<domain>:read` is seeded to all three roles to
  preserve today's behavior — **except** `accessGrant:read` and `user:read`, seeded to ADMIN + MEMBER
  only (VIEWER loses them). This closes the worst read-exposure on day one.
- **"Fundación unificada + SA fast-follow."** This permission catalog is the shared vocabulary that
  will **also** serve service accounts later — design it clean and reusable, not coupled to humans.

Constant constraints carried from the auth arc:

- **INV-1 ([[INVARIANTS]]):** authorization is DB-first; a token claim is never an authorization
  source. Permissions must resolve from DB rows, like roles do.
- **The ADMIN set is immutable/full** so the last-admin / first-admin invariants ([[INVARIANTS]] INV-7
  + the ADR-0040 last-admin guard) stay intact — an ADMIN must always be omnipotent.
- **Permissions are lazyit-local** — they NEVER sync to Zitadel. Only the 3 coarse roles keep their
  existing `grantRole` write-back ([[0043-zitadel-source-of-truth]] §3); fine-grained permissions are
  invisible to the IdP.

## Considered options

- **Option A — Fixed roles + configurable permissions, catalog-as-code (chosen).** Keep the 3-role
  enum; introduce a frozen `Permission` catalog (`domain:action` strings) defined as zod-in-shared,
  and a `RolePermission` table mapping each role → its permissions. Authorization shifts from
  "is your role in this set" to "does your role hold this permission". The catalog is closed and
  reviewable; the matrix is data (seeded, later editable via an ADMIN config surface). One vocabulary,
  reusable for service accounts later.
- **Option B — Dynamic custom roles (a `Role` table + arbitrary role creation).** Maximum flexibility:
  operators define their own roles and assign permissions freely. Rejected for now: it breaks the
  fixed-role invariants the whole auth stack leans on (last-admin, first-user-ADMIN, the IdP role
  mirror of exactly three project roles), adds a role-management UI + lifecycle, and over-serves a
  5–20-person single-org team. **Deferred to a future ADR**, not discarded.
- **Option C — Keep ADR-0040 as-is (coarse `@Roles` only).** Zero new surface. Rejected: it leaves the
  role→capability mapping uneditable-without-code and the sensitive reads wide open — the two gaps
  this ADR exists to close.

## Decision

Adopt **Option A**. The shape:

### 1. Roles stay fixed; permissions become the unit of authorization

`enum Role { ADMIN MEMBER VIEWER }` is **unchanged** (schema, `RoleSchema` in `@lazyit/shared`, the IdP
mirror of exactly three project roles — all untouched). What changes is that a privilege decision will
(in a later wave) ask **"does the actor's role hold permission `X`?"** instead of **"is the actor's
role in set `{…}`?"**. The role is still the thing a user *has*; permissions are what a role *grants*.

> [!note] One deliberate, bounded carve-out to "never per-record/per-row ACLs" — the KB folder
> This ADR keeps ADR-0040's rejection of any per-resource permission matrix **in force** (authorization
> is per-domain; Option B's per-record/per-row ACL stays rejected). [[0060-kb-folder-access-control]] is
> a single, **explicit exception** — and a narrow one: KB access attaches to a **Folder** (a bounded,
> named set), **never to individual article rows**, so the "not per-record" spirit is preserved. It is an
> orthogonal **data-scoping** axis layered *on top of* this unchanged catalog: the `article:read`
> capability below still gates whether you may act at all; the folder ACL only narrows **which** articles
> you see. KB documents are inherently access-tiered in a way assets/consumables are not — which is why
> the carve-out is bounded to the KB and not generalized. A second new ADR,
> [[0061-secret-manager-zero-knowledge]], **extends this catalog** with a new `secret` capability domain
> (`secret:read` / `secret:manage`, ADMIN-only by default — same SoD precedent as `workflow:secrets`);
> note that per-vault **crypto** membership there is a *second, orthogonal* layer the catalog does not
> express (a capability lets you ENTER; a wrapped DEK lets you DECRYPT). See INV-9 / INV-10 in [[INVARIANTS]].

### 2. Catalog-as-code — a frozen `Permission` vocabulary in `@lazyit/shared`

The catalog is a **closed zod enum** of `domain:action` literals (`PermissionSchema` /
`PERMISSIONS`), with the inferred `Permission` type and a `RolePermissionMatrix` wire shape
(`Record<Role, Permission[]>`) — all in `@lazyit/shared` so `api` (seed, guard) and `web` (a future
config UI) share one definition. **Catalog-as-code, not a DB-driven dictionary:** a typo can't mint a
permission, CI fails on an unknown literal, and the set is greppable and reviewable. Domains are the
existing modules (`asset`, `application`, `accessGrant`, `consumable`, `article`/KB, `location`,
`assetModel`, `category`, `user`, `dashboard`, `search`, `settings`). Actions are `read | write |
delete` plus the **coarse capability verbs** that map to today's ADMIN-only gates: `accessGrant:grant`,
`user:manage`, `settings:manage`. Read-only surfaces (`dashboard`, `search`) expose only `:read`.

The catalog is deliberately **not coupled to the `User`/`Role` model** — it is a flat capability list,
so the same vocabulary authorizes **service accounts** in the fast-follow ("fundación unificada + SA").

### 3. `RolePermission` table — the DB-first authorization source

```prisma
model RolePermission {
  role       Role
  permission String
  @@id([role, permission])
  @@map("role_permissions")
}
```

`permission` is a plain `String` (not a Postgres enum) on purpose: the closed catalog lives as zod in
shared, so the DB stays a flat key/value the seed and a future config endpoint write 1:1 — adding a
permission never needs an enum migration. **INV-1 holds:** authorization resolves from these rows,
never a token claim. The table has no soft-delete / timestamps — the composite PK is the row's
identity (it is small configuration, not domain data).

### 4. Read-authz rollout — default-open, then tighten the two sensitive reads

The seed (P1) is taken **1:1 from the [[0040-rbac-roles]] capability matrix** with the CEO's
pre-tightening:

| Role | Seeded permissions |
| --- | --- |
| **ADMIN** | the **COMPLETE** catalog (every permission) — immutable/full |
| **MEMBER** | every `:read` + every `:write` (no `:delete`, no coarse verb — all ADMIN-only per ADR-0040) |
| **VIEWER** | every `:read` **except** `accessGrant:read` and `user:read` |

So **every `<domain>:read` is granted to all three roles** (behavior-preserving — today's GETs stay
reachable by any authenticated user) **except the two pre-tightened reads**, which become ADMIN +
MEMBER only. VIEWER loses the user directory and the access-grant ledger — the worst read-exposure —
on day one. This is the **only** behavior delta in the foundation, and it only takes effect once the
enforcement wave annotates those GETs; the table + seed alone change nothing.

The seeded matrix is derived from a **single source-of-truth constant** (`DEFAULT_ROLE_PERMISSIONS` in
`@lazyit/shared`) that both the seed and a golden test consume, so the documented matrix and the
seeded rows can never drift (a wrong seed fails CI).

> **Note (issue #175, Wave 3c-1a) — a third read tier: ADMIN-only reads.** The read policy gains a
> tier strictly tighter than the pre-tightening: `ADMIN_ONLY_READS` (today just **`logs:read`**) is
> excluded from BOTH the MEMBER and VIEWER seed defaults, so only ADMIN holds it by default (via the
> complete-catalog short-circuit). Where a pre-tightened read stays open to ADMIN + MEMBER, an
> admin-only read is ADMIN alone. The two sets are disjoint. `logs:read` gates the future
> Reports/Informes section over the **estate-wide activity log**, which aggregates who-did-what across
> every domain and is therefore the most sensitive read in the catalog — hence the most restrictive
> default. It remains **configurable** (an admin may grant it to MEMBER/VIEWER from the role matrix);
> this wave only adds the catalog entry + the ADMIN-only default. **No endpoint is gated yet** (the
> `logs` GET annotation is a later wave, 3c-1b), so this is purely additive: the only thing that
> changes today is the seeded matrix. This extends §4 without a new ADR.

### 5. ADMIN is immutable/full; permissions never touch the IdP

The ADMIN permission set is, by decision, the entire catalog and is **never editable** — the future
config surface must refuse to edit it, so the last-admin / first-admin invariants stay intact and an
ADMIN is always omnipotent. Fine-grained permissions are **lazyit-local**: they are NEVER written back
to Zitadel. Only the three coarse roles keep their existing `grantRole` mirror
([[0043-zitadel-source-of-truth]] §3); the IdP knows nothing of permissions.

### Phased delivery

- **P0 — this ADR + the new invariant.** (done)
- **P1 — the contract + the table.** The shared `Permission` catalog + `RolePermissionMatrix`; the
  `RolePermission` model + migration; the idempotent seed from `DEFAULT_ROLE_PERMISSIONS`; the golden
  test. **Additive, behavior-preserving — nothing consumes `RolePermission` yet.** (done)
- **P2 — `@RequirePermission` decorator + the guard evolution** that reads `RolePermission`. (done)
  The `RolesGuard` is now DUAL-MODE: `@Public` skips; `@RequirePermission` resolves the caller's
  permission set from the `RolePermission` rows (via a lazy in-process `PermissionResolverService`
  cache, ADMIN always full) and 403s unless the role holds every required permission; the existing
  `@Roles` sites keep their coarse role-membership check unchanged; a route with neither stays
  open-by-default. Same `APP_GUARD` slot/order (after `JwtAuthGuard`). Behavior-preserving on its own.
  (The dual-mode was a **migration scaffold**; P4 retired the `@Roles` branch, leaving only the
  `@RequirePermission` path.)
- **P3 — annotate the GETs** (this is where the two pre-tightened reads actually bite). (done) Every
  GET carries `@RequirePermission('<domain>:read')`. The ONLY behavior change is VIEWER → 403 on the
  access-grant reads (`GET /access-grants`, `/access-grants/:id`, `/applications/:id/access-grants`,
  `/users/:id/access-grants`) and the user-DIRECTORY reads (`GET /users`, `/users/:id`,
  `/users/:id/assignments`). `GET /users/me` stays OPEN (the self-read the frontend gates admin UI
  off). `GET /search` is gated `search:read` (open to all) and additionally drops the `users` facet
  from results for a caller without `user:read`, so a VIEWER cannot enumerate emails via search.
- **P4 — migrate the existing `@Roles` sites** to `@RequirePermission`, then RETIRE the legacy path.
  (done) The 63 `@Roles` write/lifecycle gates were swapped 1:1 to the `@RequirePermission` whose
  seed-holders EXACTLY equal the old `@Roles` set — **behavior-preserving**, proven by a golden parity
  test (`apps/api/src/auth/permission-parity.golden.spec.ts`) that fails CI on any role-set drift:
    - ordinary writes (create/update; consumable movements; asset assignments) → `<domain>:write`
      (ADMIN+MEMBER hold it).
    - destructive deletes **and** their inverse restores → `<domain>:delete` (ADMIN-only — delete and
      restore deliberately **share** the lifecycle permission, since restore is the inverse of delete).
    - AccessGrant mutations (open/revoke/patch notes·expiry/batch-revoke) → `accessGrant:grant`
      (ADMIN-only) — **never** `accessGrant:write`, which MEMBER holds as an intentional orphan slot;
      using it would have silently handed MEMBER an ADMIN-only Access write.
    - Users administration (create/update incl. role/offboard/restore) → `user:manage` (ADMIN-only
      coarse verb), **not** `user:write` (which MEMBER holds).
    - the config `/setup` surface stays `@Public` (no authenticated session at first-run), so there was
      **no `settings:manage` enforcement site yet** — that permission stayed catalog-only until P5, which
      makes `GET`/`PUT /config/permissions` its first real gate.
  With every site migrated, the legacy `@Roles` decorator + `ROLES_KEY` and the guard's dual-mode
  `@Roles` branch were **removed**: the authorization guard is now the SINGLE `@RequirePermission`
  primitive — `@Public` → `@RequirePermission` → open-by-default (the handful of unannotated routes,
  e.g. hello-world / `GET /users/me`, stay reachable per INV-8). `@Public` and `JwtAuthGuard` are
  untouched.
- **P5 — the config endpoints** (read/update the matrix; ADMIN row immutable). (done) The configurable
  surface, all on the `config` module:
    - `GET /config/permissions` + `PUT /config/permissions`, both `@RequirePermission('settings:manage')`
      — the **first real enforcement site** for `settings:manage` (ADMIN-only in the seed; catalog-only
      until now). GET returns the current `RolePermissionMatrix` from the `RolePermission` rows (ADMIN
      reported as the COMPLETE catalog — what the resolver enforces, never the rows). PUT replaces the
      **MEMBER + VIEWER** sets wholesale (a full PUT), validated against the frozen `@lazyit/shared`
      catalog — an unknown permission → 400.
    - **ADMIN is immutable**: the strict PUT body (`UpdateRolePermissionsSchema`) accepts ONLY `MEMBER`
      and `VIEWER` keys, so an `ADMIN`/extra key → 400; combined with the resolver's ADMIN-is-full
      short-circuit, ADMIN can never be scoped down (INV-8). MEMBER/VIEWER are otherwise fully
      configurable within the catalog (granting MEMBER a `:delete` or a coarse verb is the intended
      feature — the only guardrails are ADMIN-immutable + catalog-membership).
    - **Transactional + audited + cache-coherent**: per editable role the desired set is diffed against
      the current rows; revoked rows are deleted and granted rows created in ONE `$transaction`, and one
      immutable `PermissionAuditLog` row is appended per change (`GRANT`/`REVOKE`, attributed to the
      actor — append-only per ADR-0006, new model + migration). On commit, `PermissionResolverService
      .invalidate()` drops the lazy cache so the very next authZ decision re-reads the DB.
    - `GET /config/my-permissions` (any authenticated user — `@RequirePermission()` with no gate)
      returns the CALLER's effective set `{ role, permissions: Permission[] }`, resolved via the SAME
      `PermissionResolverService` the guard uses, so the frontend can derive `can('domain:action')`
      without polluting the `User` wire shape.
- **P7 — the config UI** (the ADMIN screen, `apps/web`). (done) Role-first design (CEO decision, NOT a
  comparison grid): `settings/roles/permissions` edits ONE editable role at a time (ADMIN shown locked),
  via one-click **presets** + plain-language **capability toggles** grouped by the four pillars, with an
  advanced **fine-tune** disclosure for raw per-permission control and a live "what this role can do"
  summary. The human layer (`PERMISSION_META` + `CAPABILITIES` + presets) lives in `@lazyit/shared` next
  to the catalog, guarded by a covering-set test so the wording can't drift from the machine catalog.
  **Fully configurable**: coarse verbs (`accessGrant:grant`/`user:manage`/`settings:manage`) and
  `:delete` ARE grantable to MEMBER/VIEWER — the UI marks them ⚠ "Admin-level" and routes a save that
  grants one (or revokes a read) through a neutral-tone consequential confirm, but never client-blocks
  (the backend has no block either; an admin-initiated delegation is accepted). `can(permission)` infra
  added (`useMyPermissions`/`useCan` over `/config/my-permissions`, fails closed); the app-wide
  migration of existing `useCanWrite` gate sites to `can()` is a separate follow-up.
- **P6b — permission-aware UI gating** (the call-site migration, `apps/web`). (done) Every former
  `useCanWrite`/`isAdmin` write/delete gate now uses `can('domain:action')` matching its backend
  `@RequirePermission` (write→`:write`, delete/restore→`:delete`, grants→`accessGrant:grant`, user
  admin→`user:manage`, settings shell + taxonomy managers→`settings:manage`/`category`·`assetModel`);
  `useCanWrite` was retired. The ONE deliberate exception is the "Show archived" toggle, kept on
  `isAdmin` because the API's `assertCanListDeleted` keeps the `deleted=only` slice role-based, not a
  permission.
- **Fast-follow — service accounts** reuse this same catalog.
- **Future ADR — dynamic custom roles** (Option B), if ever needed.

### Single-instance assumption + resolver cache TTL (issue #592, 2026-06-20)

The `PermissionResolverService` uses a process-local `Map` to cache resolved permission sets.
After a matrix edit via `PUT /config/permissions`, the P5 handler calls `invalidate()` to drop
the cache on the **same API process**. A second API instance (or a future horizontal scale-out)
would hold a **stale** cached set indefinitely — an authorization-correctness gap on revoke.

**Decision (CEO, 2026-06-20):** add a short TTL (`PERMISSION_CACHE_TTL_MS = 60_000` ms / 60 s)
to each cache entry. An entry older than 60 s is treated as a miss; the resolver re-reads the DB
on the next authZ decision. Explicit `invalidate()` still drops entries immediately (the same-node
fast path remains). No new infrastructure is required.

**Single-instance assumption (documented constraint, not an invariant):** lazyit's production
topology is a **single API container** (no `replicas`). On a single node, the 60 s TTL bounds
staleness: any matrix change is visible to every request within 60 s of the edit (or sooner via
`invalidate()`). This is acceptable for a 5–20-person team.

**Deferred — Valkey pub/sub invalidation:** if horizontal scaling becomes real (multiple API
replicas behind a load balancer), add a Valkey pub/sub channel: the P5 handler publishes an
invalidation message after the DB commit; every replica's subscriber calls `invalidate()`. Valkey
already runs for BullMQ — no new infrastructure is needed. The 60 s TTL acts as a backstop even
then. This is the only remaining cross-node RBAC gap; track it when `replicas > 1` is introduced
in the deployment config.

**What does NOT change:** INV-1 (DB-first authZ) and INV-8 (ADMIN-is-full, immutable) are
unaffected. The TTL only bounds how long a cached answer lives; it does not change what the DB
resolves. A cache entry expiring during a user's active session causes at most a single extra DB
read on the next `@RequirePermission` check — no user-visible disruption.

## Consequences

- **Positive:**
  - The role→capability mapping becomes **data** (a seeded matrix), the groundwork for editing it
    without a code change (P5) — and a single place that states the whole matrix.
  - The two worst read exposures (`user:read`, `accessGrant:read`) are pre-tightened to ADMIN+MEMBER
    on day one (once P3 lands), closing them without a configurability project.
  - One **reusable** permission vocabulary for humans *and* service accounts.
  - Authorization stays **DB-first and IdP-neutral** (INV-1); permissions never leak to the IdP.
  - The ADMIN-is-full invariant keeps the last-admin / first-admin safety net intact.

- **Negative / trade-offs:**
  - A second authorization axis (roles *and* permissions) is more surface than ADR-0040's single
    `@Roles`. Mitigated by catalog-as-code (closed, typed, CI-checked) and a phased rollout.
  - Still per-domain, not per-record — a richer/multi-tenant deployment would need more (Option B);
    accepted for the 5–20-person target.
  - The foundation ships a table nothing reads yet. **Intentional**: it lets the contract + seed + test
    land and be reviewed before any enforcement behavior changes.

- **Follow-ups (separate PRs / ADRs):** P2–P5 above; the service-account fast-follow; the
  dynamic-custom-roles future ADR (Option B).

Related: [[0040-rbac-roles]] · [[0043-zitadel-source-of-truth]] · [[0038-jit-user-provisioning]] ·
[[0060-kb-folder-access-control]] · [[0061-secret-manager-zero-knowledge]] ·
[[INVARIANTS]] · [[user]] · [[shared-package]]
