---
title: "lazyit — Status (June 2026): RBAC v2 + Service Accounts — the decisions, what shipped, what's deferred"
tags: [status, review, executive-summary, auth, authz, rbac, permissions, service-accounts]
status: living
created: 2026-06-03
updated: 2026-06-03
---

# lazyit — June 2026: RBAC v2 + Service Accounts

> The CEO directed an **authorization epic** that turned lazyit's coarse role gate into a fine-grained,
> configurable permission system, added a first-class **non-human principal** (service accounts), and
> shipped a **guided first deploy**. All of it landed on `dev` (verified 2026-06-03). This summary
> surfaces **the CEO's decisions first** (§A) — the forks taken, with rationale — then what shipped
> (§B), the new invariants (§C), and what was deliberately deferred (§D).
>
> Authoritative: [[0046-roles-permissions-v2]] · [[0047-guided-first-deploy-bootstrap]] ·
> [[0048-service-accounts]]. Architecture: [[authorization]]. Non-negotiables: [[INVARIANTS]].

---

## A. The CEO's decisions (the forks taken)

These are the calls the CEO made. They are recorded in the ADRs; restated here so they stay visible and
manageable.

### A1. Roles & Permissions v2 — **3 fixed roles + configurable permissions** (not custom roles)

> **"3 roles fijos + permisos configurables."** — the CEO

Keep `enum Role { ADMIN MEMBER VIEWER }` **exactly as-is**; make the *permissions* each role grants
**configurable** data. Authorization shifts from "is your role in this set?" to "does your role **hold**
this permission?". This is **not** dynamic custom roles (a `Role` table + arbitrary creation) — that was
considered (Option B) and **deferred to a future ADR**, because it would break the fixed-role invariants
the whole auth stack leans on (last-admin, first-user-ADMIN, the IdP mirror of exactly three project
roles) and over-serves a 5–20-person team.

- **Why this shape:** the catalog is **closed and reviewable** (catalog-as-code in `@lazyit/shared`); the
  matrix is **data** (seeded, then editable); ONE vocabulary that **also** authorizes service accounts.
- **Reopened ADR-0040 → [[0046-roles-permissions-v2]]** — it *supersedes the authZ MECHANISM* of
  [[0040-rbac-roles]] (the coarse `@Roles` gate) while **keeping** its per-domain philosophy (never
  per-record ACLs) and **extending** [[0043-zitadel-source-of-truth]] (DB-first, IdP-neutral authZ).

### A2. Close read-authorization with a **safe default**

Every `<domain>:read` is granted to **all three roles** (behavior-preserving) **EXCEPT** the two most
sensitive reads — **`accessGrant:read`** and **`user:read`** — pre-tightened to **ADMIN + MEMBER only**.
So a **VIEWER can no longer enumerate the access map or the user directory** (and the `/search` users
facet is dropped for a caller without `user:read`). This **closed the long-standing read-authz gap** (the
old DEF-001 residual / debt #1 from the May review) without a configurability project — on day one of
enforcement.

### A3. Permissions are **lazyit-LOCAL** — never synced to the IdP

Fine-grained permissions are **never** written back to Zitadel (only the three coarse roles keep their
`grantRole` mirror). AuthZ stays **DB-first** (INV-1): a token claim is never an authorization source.
This keeps authZ **vendor-neutral and BYOI-safe** — a generic OIDC IdP need not know anything about
permissions. The **ADMIN permission set is immutable/full** (the complete catalog, never editable), so an
ADMIN is always omnipotent and the last-admin / first-admin invariants stay intact (INV-8).

### A4. The matrix is **FULLY configurable** (admin-delegated, no server block)

The coarse verbs (`settings:manage` / `user:manage` / `accessGrant:grant`) **and** `:delete` **ARE**
grantable to MEMBER/VIEWER. The UI marks them ⚠ "Admin-level" and routes such a save through a
consequential confirm, but **never client-blocks**, and **the backend has no block either** — an
admin-initiated delegation is **accepted by design**. The only guardrails are *ADMIN-immutable* +
*catalog-membership*.

### A5. Permissions UX = **role-first**, not a comparison grid

The editor edits **one role at a time** (ADMIN shown locked) via one-click **presets** + plain-language
**capability toggles** grouped by pillar, with an advanced **fine-tune** disclosure and a live "what this
role can do" summary. The human wording (`PERMISSION_META` / `CAPABILITIES` / presets) lives next to the
machine catalog in `@lazyit/shared`, guarded by a covering-set test so it can't drift.

### A6. Service Accounts = a **separate model + a lazyit-native hashed token**

> A SEPARATE `ServiceAccount` — **not** a `type` flag on `User`, **not** a Zitadel machine-user. — the CEO

Automation gets a **first-class non-human principal** ([[0048-service-accounts]]):

- **Auth = a lazyit-native token** `lzit_sa_<id>_<secret>` (256-bit random, stored only as a SHA-256
  hash + a non-secret prefix, shown **once**, constant-time-verified) — **BYOI-safe** (no IdP on the
  bot's path), revocable in our own DB.
- **AuthZ = direct grants from the SAME catalog** humans use — **never** a `Role`, **never** ADMIN,
  **fail-closed** (it 403s on unannotated routes; it does NOT inherit the human open-by-default).
- A separate model keeps bots **out of** JIT, the directory, email-linking and the last-admin math.
- **The Zitadel machine-user mirror is deferred** (the IdP seam stays open; BYOI no-ops).

### A7. `start.sh` = a **guided, idempotent, non-destructive** first deploy

A thin POSIX-`sh` wrapper ([[0047-guided-first-deploy-bootstrap]]) over the existing env contract + prod
compose: **DETECT → ASK → GENERATE → UP → POINT**. It eliminates the three classic foot-guns (the
exactly-32-char `ZITADEL_MASTERKEY`, the `DATABASE_URL`/`POSTGRES_PASSWORD` coupling, the forgotten
`chmod 600`), **never** regenerates the unrotatable masterkey, has **no teardown path**, and points the
operator at `/setup`. It creates **no** user (that's the wizard) and makes **no** Zitadel API call
(that's the sidecar).

---

## B. What shipped (merged to `dev`)

### B1. Schema / new entities (one migration arc)

| New | What |
| --- | --- |
| [[role-permission]] | the editable `role → permission` map (the DB-first authZ source) |
| [[permission-audit-log]] | append-only trail of matrix edits (GRANT/REVOKE) |
| [[service-account]] | the non-human principal (hashed token, soft-delete, optional expiry) |
| [[service-account-permission]] | a service account's direct grants |
| [[service-account-audit-log]] | append-only SA lifecycle trail (mint/rotate/revoke/restore/permission-change) |
| actor columns | a nullable `serviceAccountId` actor column on the **6** audit-bearing tables ([[asset-history]], [[asset-assignment]] ×2, [[access-grant]] ×2, [[consumable-movement]], [[article-version]], [[article-link]]) + an **at-most-one-actor CHECK** |

### B2. Endpoints

- `GET`/`PUT /config/permissions` + `GET /config/my-permissions` (the matrix surface; the first real
  `settings:manage` gate).
- `/service-accounts` CRUD (`POST` / `GET` / `GET :id` / `PATCH` / `POST :id/rotate` / `DELETE` /
  `POST :id/restore`) — all `settings:manage`.
- **41 read `GET`s** annotated `@RequirePermission('<domain>:read')`; the **63 write** sites migrated
  from `@Roles` to `@RequirePermission` (1:1 role-set, parity-tested); **`@Roles` RETIRED** —
  `@RequirePermission` is the SINGLE enforcement primitive.

### B3. Auth (backend)

- `@RequirePermission` + the permission guard: **DB-first**, ADMIN short-circuit (full, no DB read),
  **fail-closed**; `PermissionResolverService` (lazy cache, invalidated on a matrix edit).
- The `JwtAuthGuard` **SA-token branch** (runs before OIDC/shim; constant-time; generic 401;
  `request.principal`).
- `ActorService.resolveActor(principal)` → the right audit actor column (human XOR service).

### B4. Shared (`@lazyit/shared`)

The permission catalog (~33), `PermissionSchema`, `RolePermissionMatrix`, `buildDefaultRolePermissions` /
`DEFAULT_ROLE_PERMISSIONS`, `PERMISSION_META` / `CAPABILITIES` / presets, the clone-defaults sanitizers,
and the `ServiceAccount` schemas (incl. the once-only `ServiceAccountWithSecretSchema`). See
[[shared-package]].

### B5. Frontend

- `/settings/roles/permissions` — the role-first editor (presets + capabilities + fine-tune).
- `/settings/service-accounts` — CRUD + the **one-time secret reveal**.
- The `can(permission)` infra (`useMyPermissions`/`useCan`, fails closed) + **ALL** UI gating migrated
  from `isAdmin` → `can()`; `useCanWrite` **retired**.
- The **Clone** feature (assets / consumables / applications / asset-models / categories / users).

### B6. Security

- **SEC-009** (Swagger not public in prod / not Caddy-proxied) and **SEC-010** (the XFF-spoof setup
  rate-limit → `trusted_proxies` + `req.ip`) **closed**.
- The **read-authz gap closed** (A2). [[summary]] + [[deferred]] reconciled; [[INVARIANTS]] already
  carried INV-8 + INV-SA-*.

### B7. Infra

- `infra/start.sh` (A7) and a `migrate.Dockerfile` fix (build `@lazyit/shared` **before** the seed, which
  now imports it).

---

## C. The new invariants ([[INVARIANTS]])

- **INV-8** — permissions resolve from `RolePermission` DB rows, never a token claim; the ADMIN set is
  immutable/full; permissions are lazyit-local.
- **INV-SA-1** — an SA token is verified DB-first; the stored secret is a SHA-256 hash, constant-time
  compared; generic 401.
- **INV-SA-2** — an SA is FAIL-CLOSED; it does NOT inherit the human open-by-default.
- **INV-SA-3** — an SA NEVER has a Role, is NEVER ADMIN-equivalent, never enters human-only logic.
- **INV-SA-4** — SA actions are audited to the service account, never a fake human; at most one actor per
  audited row (DB CHECK).

---

## D. Deferred / follow-ups (deliberate, recorded)

- **[[service-account-audit-log]] has no SA actor column** — an SA self-managing SAs records
  `actorId = null` (honest); adding the column is a future ADR/migration.
- **SA-authored KB articles are rejected (403)** — `Article.authorId` is a non-null [[user]] FK by design;
  the SA actor columns on [[article-version]]/[[article-link]] stay schema-present but unreachable.
- **Zitadel machine-user mirror** — deferred (the IdP seam stays open; BYOI no-ops).
- **Dynamic custom roles** (Option B) — a future ADR if ever needed.
- **The matrix "Show archived" toggle stays role-based** (`isAdmin`) — the API's `deleted=only` slice is
  role-based, not a permission.
- **Parked, gated on async workers (BullMQ + Redis):** backups-from-frontend and the application workflow
  engine (P4). Both wait on the worker decision (a pending ADR — see [[03-decisions/_MOC|Decisions]]).

---

## Index

This folder contains this summary + `README.md`. The decisions are authoritative in
[[0046-roles-permissions-v2]] / [[0047-guided-first-deploy-bootstrap]] / [[0048-service-accounts]]; the
architecture in [[authorization]]; the invariants in [[INVARIANTS]]; the operator runbook in
[[managing-service-accounts]]. Prior arc: [[status_may_2026/00-EXECUTIVE-SUMMARY|May 2026]].
