---
title: "ADR-0046: Roles & Permissions v2 — fixed roles, configurable permissions (catalog-as-code)"
tags: [adr, auth, authz, rbac, permissions, security]
status: accepted
created: 2026-06-02
updated: 2026-10-21
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

**Amended** — 2026-10-09 (#1543) by [[0102-remove-bundled-zitadel]]: the three coarse roles no longer keep a
`grantRole` write-back — lazyit writes nothing to the IdP, so roles are lazyit-local like permissions.

**Amended** — 2026-10-15 (SEC-088, AUD-002): a delegated `user:manage` is bounded by a role ceiling. See
*Amendment — the role ceiling on a delegated `user:manage`* below.
**Amended** — 2026-10-16 (SEC-088, CEO decision): `PUT /config/permissions` is ADMIN-only; a delegated
`settings:manage` no longer edits the matrix. See *Amendment — the matrix is edited by an ADMIN only* below.
**Amended** — 2026-10-16 (SEC-088, CEO decision): a delegated `settings:manage` no longer saves SMTP, and
mints service-account verbs only within its own role. See *Amendment — SMTP and service accounts* below.

> **Superseded in part** by [[0104-custom-roles]] (2026-10-21, CEO decision on #1560): **§1** (the three
> roles stay fixed) and the deferral of Option B. Custom roles are the accepted direction: a `roles`
> table with ADMIN, MEMBER and VIEWER as protected system rows. **The build is deferred**, so until
> ADR-0104's U1 ships the code still runs exactly what §1 describes. The catalog (§2), the DB-first
> role-to-permission map (§3), the read tiers (§4), ADMIN as the immutable full set (§5) and the
> amendments below still stand.

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
  5–20-person single-org team. **Deferred to a future ADR**, not discarded. *(Accepted 2026-10-21 in
  [[0104-custom-roles]], build deferred.)*
- **Option C — Keep ADR-0040 as-is (coarse `@Roles` only).** Zero new surface. Rejected: it leaves the
  role→capability mapping uneditable-without-code and the sensitive reads wide open — the two gaps
  this ADR exists to close.

## Decision

Adopt **Option A**. The shape:

### 1. Roles stay fixed; permissions become the unit of authorization

> **Superseded** by [[0104-custom-roles]] (2026-10-21). Permissions stay the unit of authorization; the
> fixed set of roles does not. The build is deferred, so this section still describes the code as it runs
> today.

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

> **Note (issue #1314) — default grants are applied once per instance.** The seed runs on every
> deploy (the `migrate` job), and it used to upsert every pair of `DEFAULT_ROLE_PERMISSIONS`. Because
> the config endpoint revokes by deleting the `RolePermission` row, every default an admin had revoked
> came back on the next update. The seed now consults an append-only ledger,
> `AppliedRolePermissionDefault` (`applied_role_permission_defaults`): a default (role, permission)
> pair is granted only when the ledger has no row for it, and the ledger row is written in the same
> transaction. A revocation deletes the grant and never the ledger row, so it survives every deploy; a
> permission newly added to the catalog has no ledger row, so each instance receives its defaults
> exactly once, on the first deploy that ships it — still with no per-permission data migration. The
> seed never deletes a grant. The migration that introduced the ledger backfilled it with every pair
> an instance held at that point plus every pair `PermissionAuditLog` records as revoked, so existing
> instances kept every grant they had. A revocation that an older seed had already silently undone
> cannot be told apart from a deliberate re-grant (the old seed wrote no audit row), so operators were
> advised to review the permission matrix once after that update. Mechanics: [[role-permission]].

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
  *Amended 2026-10-14 (AUD-015):* "open to all" held only for the default matrix. `GET /search` now drops
  **every** index whose `<domain>:read` the caller lacks (the same read its dedicated routes require), not
  only `users` and the purchase indexes — see [[0035-search-architecture]], amendment 2026-10-14.
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
      feature — the only guardrails are ADMIN-immutable + catalog-membership). *Amended 2026-10-15:* a
      delegated `user:manage` is additionally bounded by the role ceiling (see the amendment below).
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
  **Amended 2026-10-08 (#1540) — the role-first editor becomes one role × capability matrix**, by CEO
  decision on the approved round-3 mockup. The original "one role at a time" screen proved hard to read:
  two pages (near-empty role cards, then ~3600px of switches with long descriptions) and no way to
  compare MEMBER with VIEWER without flipping tabs and remembering. `settings/roles` is now ONE page:
  capabilities in rows (grouped by pillar, collapsible, with an n/m summary per role), ADMIN shown locked
  as a reference column, MEMBER and VIEWER editable side by side, a preset selector in each role's
  column header, descriptions behind "?" tips and ⚠ for admin-level capabilities. Both roles stage
  together and save in the same full-matrix `PUT /config/permissions` behind one save bar; the
  consequential confirm runs over both roles exactly as before, fine-tune stays below the matrix, and the
  separate "what this role can do" summary is dropped because the matrix is that summary.
  `settings/roles/permissions` redirects to `settings/roles`. Nothing in the API, the catalog, the human
  layer or the "fully configurable, never client-blocked" rule changes.
- **P6b — permission-aware UI gating** (the call-site migration, `apps/web`). (done) Every former
  `useCanWrite`/`isAdmin` write/delete gate now uses `can('domain:action')` matching its backend
  `@RequirePermission` (write→`:write`, delete/restore→`:delete`, grants→`accessGrant:grant`, user
  admin→`user:manage`, settings shell + taxonomy managers→`settings:manage`/`category`·`assetModel`);
  `useCanWrite` was retired. The ONE deliberate exception is the "Show archived" toggle, kept on
  `isAdmin` because the API's `assertCanListDeleted` keeps the `deleted=only` slice role-based, not a
  permission.
- **Fast-follow — service accounts** reuse this same catalog.
- **Future ADR — dynamic custom roles** (Option B): written as [[0104-custom-roles]] (accepted 2026-10-21,
  build deferred).

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

### Amendment — the role ceiling on a delegated `user:manage` (SEC-088, AUD-002, 2026-10-15)

P5 and P7 accepted delegating the coarse verbs to MEMBER or VIEWER with no ceiling. For `user:manage`
that made every holder ADMIN-equivalent: it could create an ADMIN, promote to ADMIN, or reset an ADMIN's
password and sign in as them (SEC-088). By CEO decision the delegation stays, bounded: a holder grants and
acts on roles at or below its own only, so only an ADMIN can create, promote to or act on an ADMIN. The
rule, its error (`403 ROLE_CEILING_EXCEEDED`) and its service-account reading are specified in
[[0040-rbac-roles]] → *Amendment — role ceiling and usable admins*.

What stays as P5/P7 described: `user:manage` and the other coarse verbs remain grantable to MEMBER and
VIEWER, and the matrix UI still warns rather than blocks. What is **not** bounded yet: a delegated
`settings:manage` can still edit the matrix for its own role, and so grant itself `user:manage` (the
second half of SEC-088, still open). Under the ceiling that reaches at most the holder's own role.
*Closed 2026-10-16 by the next amendment.*

### Amendment — the matrix is edited by an ADMIN only (SEC-088, 2026-10-16)

CEO decision: editing the permission matrix and the directory connection is ADMIN-only until custom roles
(#1560) give them their own verb; a delegated `settings:manage` no longer covers them. `PUT
/config/permissions` keeps `@RequirePermission('settings:manage')` and adds `AdminOnlyGuard`, which refuses
any caller that is not a human whose DB role is ADMIN with **403** `ADMIN_REQUIRED`, whatever the matrix
grants its role. `GET /config/permissions` is unchanged: a `settings:manage` holder still reads the matrix.
A service account was already refused on both routes (INV-SA-3) and still is.

This narrows P5/P7 for one verb on one route. `settings:manage` stays delegable and still gates the rest
of instance configuration. The matrix UI keeps offering `settings:manage` to MEMBER and VIEWER; a holder
sees the matrix but cannot save it. The directory connection write follows the same rule
([[0091-on-prem-ad-ldap-directory-source]]). No data change: an instance that delegated `settings:manage`
keeps the rows, and the holders lose only the matrix and directory writes.

### Amendment — SMTP and service accounts (SEC-088, 2026-10-16)

CEO decision, closing SEC-088. Two more `settings:manage` surfaces reached past the holder's own role:
- **SMTP.** Repointing outbound mail at a relay the holder controls, then requesting an ADMIN's password
  reset, hands them the reset link. `PUT /config/smtp` now carries `AdminOnlyGuard` (**403**
  `ADMIN_REQUIRED`); the read and the test send stay on `settings:manage`
  ([[0079-instance-smtp-outbound-email]]).
- **Service accounts.** A holder could mint a token with verbs its own role lacks. Every write that
  issues or re-arms a token is now capped at the caller's own verbs (**403**
  `PERMISSION_CEILING_EXCEEDED`, [[0048-service-accounts]]), the same "only what you could grant by
  hand" rule as the user clone ([[0058-user-manager-and-clone-actions]]).

`settings:manage` stays delegable for the rest of instance configuration. No data change.

### Amendment — write implies read (#1518, 2026-10-21)

CEO decision on #1518: the matrix cannot hold a write without its read. A role holding any non-read verb
on a domain (`X:write`, `X:delete`, `X:manage`, `accessGrant:grant`, the `workflow` verbs, …) also holds
that domain's `X:read`, because a write route answers with the row it wrote, and a role allowed to change
something it cannot see is incoherent. The mapping is derived from the catalog (`IMPLIED_READS` in
`permission.ts`: every non-read verb of a domain that has a `:read`). Three verbs are exempt because
their read is something else: `accessRequest:create` (self-service; its read is the requester's own
`GET /access-requests/mine`, and `accessRequest:read` stays pre-tightened away from VIEWER),
`secret:fetch` (the service-account fetch is its own read) and `infra:report` (the agent's ingestion verb,
which confers no read). Verbs of a read-less domain (`import:run`, `ai:use`, `ai:connect`) imply nothing.

- **The editor enables the read automatically.** Ticking a permission ticks the read it needs; clearing a
  read clears what needs it, and the save's consequential confirm names those permissions. P7's "warn,
  never client-block" rule holds: the un-tick is not blocked.
- **The server enforces it on save.** `PUT /config/permissions` refuses with **400**
  `PERMISSION_READ_REQUIRED` (`violations: [{ role, permission, requires }]`) a body that grants a non-read
  permission without its read or revokes a read a kept permission needs.
- **Legacy matrices are tolerated and self-heal.** `GET /config/permissions` and the resolver read stored
  rows as they are. A write-without-read the stored matrix already held is healed on the next save by
  adding the read — never by removing the write — and audited as a GRANT. That widens what the role can
  see for that domain; it never narrows what it can do.
- **Defaults and presets already obey the rule** (a shared test pins it), so neither the seed nor an
  upgrade adds anything by itself.
- **Not extended to service accounts.** Their grants are a separate, least-privilege set
  ([[0048-service-accounts]]); whether the rule should apply there is an open question on #1518.

The P5 sentence "the only guardrails are ADMIN-immutable + catalog-membership" now has a third guardrail.

### Amendment — the `ai` permission domain (ADR-0097, #1315, 2026-09-26)

[[0097-ai-assistant-mcp-and-headless-api|ADR-0097]] adds a domain to the catalog, `ai`, with two
**access verbs** split by channel so an operator can allow one without the other:

- **`ai:use`** — the in-app chat and the headless API (`POST /ai/runs` from a Service Account).
- **`ai:connect`** — external agents over MCP: OAuth 2.1 grants on HTTPS instances, personal tokens on
  `lan`, and the tokens of Service Accounts that hold it (R10, fail-closed).

**They grant no domain capability.** The AI always acts as the invoking principal with exactly its own
permissions (INV-AI-1), so holding `ai:use` adds a *channel*, not a *power*: every tool call still goes
through the bound route's `@RequirePermission` via the delegated-identity branch of `JwtAuthGuard`, and a
tool's permission is derived from that route at boot, never declared by hand (INV-AI-2). This is what
keeps §2's catalog-as-code the single authorization vocabulary — the AI layer adds no parallel map.

**Defaults.** Both are **MEMBER-default capabilities** (`MEMBER_DEFAULT_CAPABILITIES` in
`permission.ts`): seeded to ADMIN (the full-catalog short-circuit, §5) and MEMBER, not VIEWER, and carried
in the within-default `edit` tier of `permission-meta.ts`, so granting one is never an escalation. They
reach existing instances through the seed-once ledger of #1314 on the next deploy — no data migration —
and an admin who revokes one keeps it revoked. Both stay grantable to a Service Account (they are not in
`SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS`). The capability is also behind instance switches that are off
by default (the chat's enable gate, the MCP switch), so the grant exposes nothing until an admin enables
AI or MCP.

**Enforcement is re-checked on every call**, not only at the HTTP entry: core re-reads `ai:use` /
`ai:connect` for the principal before listing, invoking, proposing or approving a tool, so a revoke takes
effect on the next tool call of a running conversation or MCP session.

**A read widened on purpose (#1428).** `GET /config/asset-tag-scheme/summary` is gated by
`asset:write` — the permission of `POST /assets` — rather than `settings:manage`, so whoever may create
assets can follow the instance's tag pattern (the asset form and the AI tool `asset_tag_scheme_get`). It is
read-only, human-only and returns no counter internals; every other asset-tag-scheme route stays
`settings:manage`. The precedent is narrow: instance configuration stays `settings:manage` unless a
domain permission already implies the need to read one non-sensitive projection of it.
→ [[authorization]] §5, §9; [[INVARIANTS]] INV-AI-1, INV-AI-2.

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
  dynamic-custom-roles future ADR (Option B), now [[0104-custom-roles]].

Related: [[0040-rbac-roles]] · [[0043-zitadel-source-of-truth]] · [[0038-jit-user-provisioning]] ·
[[0060-kb-folder-access-control]] · [[0061-secret-manager-zero-knowledge]] ·
[[INVARIANTS]] · [[user]] · [[shared-package]] · [[0097-ai-assistant-mcp-and-headless-api]] ·
[[authorization]] · [[0104-custom-roles]]
