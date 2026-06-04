---
title: "Authorization — the @RequirePermission single-guard model (Roles & Permissions v2 + Service Accounts)"
tags: [architecture, auth, authz, rbac, permissions, service-accounts, security]
status: accepted
created: 2026-06-03
updated: 2026-06-03
---

# Authorization — `@RequirePermission`, DB-first, two principal kinds

> **Decisions of record:** [[0046-roles-permissions-v2]] (fixed roles + configurable permissions) ·
> [[0048-service-accounts]] (a non-human principal). Authentication (who you are) is the Zitadel/OIDC
> dossier [[auth-zitadel-sot]] / [[0043-zitadel-source-of-truth]]; **this note is authorization** (what
> you may do). The non-negotiables are [[INVARIANTS]] (INV-1, INV-8, INV-SA-1…4); this note is the
> architecture *behind* them. Don't contradict the ADRs — align to them.

## 0. The model in one paragraph

lazyit authorizes by **fine-grained permissions**, not coarse roles. A privilege decision asks
**"does the actor hold permission `domain:action`?"** — resolved **DB-first** (never from a token
claim) — and there is a **single enforcement primitive**: the `@RequirePermission(...)` decorator + the
permission guard. There are **two principal kinds**: a **human** [[user]] (whose permissions come from
its fixed `Role` via the editable [[role-permission]] matrix) and a **service account** (a non-human
[[service-account]] whose permissions are direct grants). The legacy coarse `@Roles()` gate from
ADR-0040 is **retired** — `@RequirePermission` is the only authZ gate the guard understands.

## 1. The permission catalog (catalog-as-code, in `@lazyit/shared`)

The vocabulary is a **frozen, closed zod enum** of `domain:action` literals (`PermissionSchema` /
`PERMISSIONS`, ~33 permissions) with the inferred `Permission` type and the `RolePermissionMatrix` wire
shape (`Record<Role, Permission[]>`), all in [[shared-package]]
(`packages/shared/src/schemas/permission.ts`). **Catalog-as-code, not a DB dictionary:** a typo can't
mint a permission, CI fails on an unknown literal, and the set is greppable and reviewable.

- **Domains** are the existing modules: `asset`, `application`, `accessGrant`, `consumable`,
  `article`/KB, `location`, `assetModel`, `category`, `user`, `dashboard`, `search`, `settings`, plus
  `logs` (the estate-wide activity history for the future Reports/Informes section).
- **Actions** are `read | write | delete` plus the **coarse capability verbs** that map to the old
  ADMIN-only gates: `accessGrant:grant`, `user:manage`, `settings:manage`. Read-only surfaces
  (`dashboard`, `search`, `logs`) expose only `:read`.
- The catalog is deliberately **not coupled to `User`/`Role`** — a flat capability list — so the SAME
  vocabulary authorizes both humans and service accounts ("fundación unificada").

## 2. The two authorization sources (both DB-first)

| Principal | What it has | Authorization source (DB rows) | Resolver |
| --- | --- | --- | --- |
| **Human** ([[user]]) | a fixed `Role` (`ADMIN`/`MEMBER`/`VIEWER`) | the editable [[role-permission]] map | `PermissionResolverService` (role → permission Set) |
| **Service account** ([[service-account]]) | direct grants (no role) | [[service-account-permission]] | resolved to a catalog Set; the role resolver is never consulted |

Both resolve from **DB rows, never a token claim** ([[INVARIANTS]] INV-1/INV-8/INV-SA-1). The
resolver caches lazily in-process and is invalidated on a matrix edit, so the next decision is
cache-coherent.

### ADMIN is immutable/full

The resolver **short-circuits ADMIN to the COMPLETE catalog without a DB read**, so a bad seed can never
lock ADMIN out, and the config surface refuses to write ADMIN rows. This keeps the last-admin /
first-admin invariants intact (INV-7 + the ADR-0040 last-admin guard). A service account is **never**
ADMIN-equivalent — there is no wildcard ([[INVARIANTS]] INV-SA-3).

## 3. The guard — one primitive, two principals, two postures

`JwtAuthGuard` (authN) sets a unified `request.principal`:

- a **human** → `{ kind: 'human', user }` (also keeps `request.user`);
- a **service account** → `{ kind: 'service', serviceAccount, permissions }` (the **SA branch runs
  BEFORE OIDC/shim**: a `Bearer lzit_sa_…` token is parsed, the row looked up by its id segment —
  including soft-deleted, so a revoked account is *seen* and rejected — the secret constant-time-compared,
  and a missing/revoked/inactive/expired account rejected as a **generic 401**, no enumeration oracle).

The permission guard (authZ) then enforces `@RequirePermission(...)`:

- **`@Public`** → skip (both principals).
- **`@RequirePermission('x','y')`** → pass only if the principal holds **every** required permission
  (human: resolved from its role's matrix, ADMIN always full; SA: contained in its grant Set).
- **unannotated, non-`@Public` route** → **diverges by principal**: a **human passes** (open-by-default,
  INV-8 — the handful of unannotated routes like hello-world / `GET /users/me` stay reachable); a
  **service account 403s** (FAIL-CLOSED — it does NOT inherit the human open-by-default, INV-SA-2). This
  is the single most important authZ difference between the two principal kinds: a forgotten gate never
  silently exposes a route to a bot.

Same `APP_GUARD` slot/order (authZ after authN). `@RequirePermission` carries the verb that matched the
old `@Roles` set 1:1 — proven by a **parity golden test** (writes → `<domain>:write`; deletes **and**
their inverse restores → `<domain>:delete` (ADMIN-only); AccessGrant mutations → `accessGrant:grant`
(**never** `accessGrant:write`, an intentional MEMBER orphan); Users admin → `user:manage` (**not**
`user:write`)).

## 4. Reads tightened (the read-authz gap closed)

41 read `GET`s now carry `@RequirePermission('<domain>:read')`. Every `<domain>:read` is seeded to all
three roles **except** two tighter tiers:

- the two **pre-tightened reads** — `accessGrant:read` and `user:read` (`VIEWER_DENIED_READS`) — seeded
  to ADMIN + MEMBER only. So a **VIEWER can no longer enumerate the access map or the user directory**
  (it gets 403); `GET /search` additionally drops the `users` facet for a caller without `user:read`.
- the **admin-only reads** — `ADMIN_ONLY_READS`, today just `logs:read` — seeded to **ADMIN only**
  (excluded from BOTH MEMBER and VIEWER, strictly tighter than the pre-tightening; the two sets are
  disjoint). `logs:read` is the **first admin-only read** (issue #175): it will gate the future
  Reports/Informes section over the estate-wide activity log. It is **seeded but not yet enforced** —
  no `logs` endpoint exists yet, so this wave only adds the catalog entry + the ADMIN-only default; the
  GET annotation lands in a later wave. Like every non-ADMIN row it stays admin-grantable from the role
  matrix.

`GET /users/me` stays open (the self-read the web gates its UI off). This closed the long-standing
read-authz gap (the old DEF-001 residual / "reads open to any authenticated user"). The seed is derived
1:1 from `DEFAULT_ROLE_PERMISSIONS` in [[shared-package]] (a golden test fails CI on drift). See
[[role-permission]] and [[0046-roles-permissions-v2]] §4.

## 5. The configurable surface

`ConfigModule`, all `@RequirePermission('settings:manage')` (the first real `settings:manage` gate):

- `GET /config/permissions` — the current `RolePermissionMatrix` (ADMIN reported as the COMPLETE
  catalog).
- `PUT /config/permissions` — replaces the **MEMBER + VIEWER** sets wholesale, validated against the
  frozen catalog (unknown → 400); the strict body accepts **only** MEMBER/VIEWER keys (ADMIN immutable →
  400 on an ADMIN/extra key). Transactional + **audited** ([[permission-audit-log]], one append-only row
  per grant/revoke) + cache-coherent (the resolver cache is invalidated on commit).
- `GET /config/my-permissions` — any authenticated user; the CALLER's effective set
  `{ role, permissions }` via the same resolver, so the web derives `can('domain:action')` without
  polluting the `User` wire shape.

**Fully configurable, admin-delegated.** Coarse verbs and `:delete` ARE grantable to MEMBER/VIEWER — the
UI marks them ⚠ "Admin-level" and confirms, but the server does not block (an admin-initiated delegation
is accepted by design). The only guardrails are *ADMIN-immutable* + *catalog-membership*.

## 6. Service accounts as a non-human principal

A [[service-account]] is a SEPARATE model — not a flag on [[user]], not a Zitadel machine user (BYOI-safe;
the IdP machine-user mirror is a deferred future ADR). It authenticates with a lazyit-native token
`lzit_sa_<id>_<secret>` (the secret is a 256-bit random, stored only as a SHA-256 hash + a non-secret
`tokenPrefix`, shown once, constant-time-verified). It is authorized by direct
[[service-account-permission]] grants from the same catalog, never a role, never ADMIN, FAIL-CLOSED.
Its `/service-accounts` CRUD is `settings:manage`-gated; every mutation is audited
([[service-account-audit-log]]). See [[0048-service-accounts]].

## 7. Honest audit attribution (the unified actor model)

When a principal performs an audited domain action, `ActorService.resolveActor(principal)` returns
`{userId}` | `{serviceAccountId}` | `{}` so the write lands in the right column. The 6 audit-bearing
append-only tables — [[asset-history]], [[asset-assignment]] (×2 actors), [[access-grant]] (×2),
[[consumable-movement]], [[article-version]], [[article-link]] — each gained a nullable
`serviceAccountId` actor column with a DB **CHECK** that at most one of (human, service) is set per actor
slot. So a row is **never** attributed to a fake human, and a two-actor row can never be persisted
([[INVARIANTS]] INV-SA-4).

> **By-design boundaries (deferred):** the [[service-account-audit-log]] has no SA actor column yet (an
> SA self-managing SAs records `actorId = null`; a future ADR/migration adds the column); and an
> SA-authored [[article]] is rejected 403 (`Article.authorId` is a non-null [[user]] FK), so the SA actor
> columns on `ArticleVersion`/`ArticleLink` stay schema-present but unreachable.

## 8. Frontend gating (`can()`)

Every former `isAdmin`/`useCanWrite` write-or-delete gate now uses `can('domain:action')` matching its
backend `@RequirePermission` (write→`:write`, delete/restore→`:delete`, grants→`accessGrant:grant`, user
admin→`user:manage`, settings/taxonomy→`settings:manage`). The `can()` infra
(`useMyPermissions`/`useCan` over `/config/my-permissions`, **fails closed** while loading);
`useCanWrite` was retired. The role-first editor lives at `settings/roles/permissions`; the
service-accounts admin at `settings/service-accounts` (one-time secret reveal). The one deliberate
exception is the "Show archived" toggle, kept on `isAdmin` because the API's `deleted=only` slice stays
role-based, not a permission. See [[0046-roles-permissions-v2]] P6b/P7, [[0020-frontend-data-layer]].

Related: [[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[0040-rbac-roles]] ·
[[0043-zitadel-source-of-truth]] · [[auth-zitadel-sot]] · [[INVARIANTS]] · [[shared-package]] ·
[[role-permission]] · [[service-account]] · [[user]]
