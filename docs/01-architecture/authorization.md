---
title: "Authorization — the @RequirePermission single-guard model (Roles & Permissions v2 + Service Accounts)"
tags: [architecture, auth, authz, rbac, permissions, service-accounts, security, ai-assistant, mcp, oauth]
status: accepted
created: 2026-06-03
updated: 2026-10-02
---

# Authorization — `@RequirePermission`, DB-first, two principal kinds

> **Decisions of record:** [[0046-roles-permissions-v2]] (fixed roles + configurable permissions) ·
> [[0048-service-accounts]] (a non-human principal) · [[0097-ai-assistant-mcp-and-headless-api]] (the AI
> channels: delegated identity, OAuth scopes, personal tokens, SA limits — §9). Authentication (who you are) is the Zitadel/OIDC
> dossier [[auth-zitadel-sot]] / [[0043-zitadel-source-of-truth]]; **this note is authorization** (what
> you may do). The non-negotiables are [[INVARIANTS]] (INV-1, INV-8, INV-SA-1…4, INV-AI-1…17); this note is the
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
  `logs` (the estate-wide activity history for the future Reports/Informes section). A
  `purchaseOrder` domain is ⚪ **planned** for Purchases Phase 1 — see the note in §4.
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

### 3.1 Local sessions — what the human branch checks (authN detail, [[0086-local-authentication-mode]])

In `AUTH_MODE=local` the human branch re-loads the [[user]] every request and refuses a `sessionEpoch`
mismatch, an inactive, soft-deleted or directory-only row. Since #1420 (§9 of the ADR) a token minted at
sign-in also carries a `sid` naming its [[user-session]] row, and the guard refuses it once that row is gone,
belongs to another user, carries another epoch or has expired — one uncached primary-key read, so ending one
device is immediate. A token without a `sid` (issued before that release) keeps the epoch-only check. The
guard records `request.localSession = { rememberMe, sessionId }` for the routes that need it
(change-password, the session list).

The session routes are **self-service and unannotated**: `GET /auth/sessions` and
`DELETE /auth/sessions/:id` pass every human (INV-8 — each person manages their own sessions; every query is
scoped to the caller's id, another user's session is a `404`) and refuse a service principal outright
(`ServicePrincipalForbiddenGuard`). There is no admin per-session route: an admin ends a user's sessions with
the existing `user:manage` levers (deactivate, offboard, password reset with *revoke sessions*), which bump
the epoch. Personal MCP tokens and OAuth grants are not sessions (§9.3).

## 4. Reads tightened (the read-authz gap closed)

41 read `GET`s now carry `@RequirePermission('<domain>:read')`. Every `<domain>:read` is seeded to all
three roles **except** two tighter tiers:

- the two **pre-tightened reads** — `accessGrant:read` and `user:read` (`VIEWER_DENIED_READS`) — seeded
  to ADMIN + MEMBER only. So a **VIEWER can no longer enumerate the access map or the user directory**
  (it gets 403); `GET /search` additionally drops the `users` facet for a caller without `user:read`.
- the **admin-only reads** — `ADMIN_ONLY_READS`, today just `logs:read` — seeded to **ADMIN only**
  (excluded from BOTH MEMBER and VIEWER, strictly tighter than the pre-tightening; the two sets are
  disjoint). `logs:read` is the **first admin-only read** (issue #175): it gates the estate-wide
  activity log behind the Reports/Informes section. **Now enforced (issue #181):** `GET /dashboard/activity`
  — the unified [[recent-activity]] feed that both the dashboard panel and the Informes screen consume —
  is annotated `@RequirePermission('logs:read')`, replacing its earlier `dashboard:read` gate and
  closing the v1 gap where the sensitive who-did-what data was reachable on a read every role held. The
  same endpoint also gained optional server-side filters (entityType/entityId/actorId/action/from/to/q).
  Like every non-ADMIN row, `logs:read` stays admin-grantable from the role matrix.

> [!note] Planned, not built — the `purchaseOrder` domain ([[0099-purchases-scope-model-and-optionality]] §8)
> Purchases Phase 1 adds `purchaseOrder:read`, `purchaseOrder:write` and `purchaseOrder:delete`, covering
> purchases, their lines and documents, and suppliers:
>
> - `purchaseOrder:read` — seeded to ADMIN + MEMBER and added to **`VIEWER_DENIED_READS`**, so a VIEWER
>   cannot see purchases or supplier prices by default. An admin can grant it to VIEWER from the role
>   matrix — for every viewer at once, since permissions are per role.
> - `purchaseOrder:write` — ADMIN + MEMBER (create, edit, receive, link/unlink, cancel, upload documents).
> - `purchaseOrder:delete` — ADMIN only (soft delete); restore stays ADMIN-only.
>
> All three are grantable to service accounts (fail-closed, §6) and reach existing instances through the
> seed-once ledger, with no data migration. They do **not** narrow `asset:read`: a viewer still sees an
> asset's own purchase cost, as today. There is **no instance switch**: Purchases is always available,
> gated only by these permissions (ADR-0099 §7).
>
> **An asset's purchase provenance follows `purchaseOrder:read`** (ADR-0099 §8, CEO decision D-A,
> 2026-10-01). The asset page's *Purchase* panel — supplier, reference, dates and the purchase documents
> listed on the asset — is served only to a principal holding `purchaseOrder:read`; the API enforces it,
> not only the UI. Without it, the asset still reads normally under `asset:read`, own purchase fields
> (cost, currency, dates) included.

`GET /users/me` stays open (the self-read the web gates its UI off). So does its one self-**write**,
`PATCH /users/me` (#1421): the caller edits their own `firstName`/`lastName` and nothing else — the
subject is the principal, never a body id, so it needs no permission; a strict body 400s any other key,
a directory-synced person gets 409 `PROFILE_MANAGED_BY_DIRECTORY`, and a service account 403s (the
fail-closed rule above plus a handler backstop). This closed the long-standing
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

**Instance configuration a non-admin may READ (read widened on purpose).** One narrow exception to "config
is `settings:manage`": `GET /config/asset-tag-scheme/summary` (#1315, follow-up of #1394) is gated
`asset:write` — the permission of `POST /assets` — so whoever may create assets can follow the instance's
tag pattern (in the asset form and through the AI tool `asset_tag_scheme_get`). It is read-only, answers
for the STORED pattern only (no query to probe others), returns the minimal non-sensitive fields
(`enabled`, `prefix`, `suffix`, `width`, and the next tag with its number — no `nextNumber` counter, no
skip count, no timestamps) and stays human-only (`ServicePrincipalForbiddenGuard`, like the rest of that
controller). Every other `/config/asset-tag-scheme` route — read, configure, seed suggestion, next-tag
preview, backfill — stays `settings:manage`. See [[asset-tag-scheme]].

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

## 9. The AI assistant, MCP and OAuth (ADR-0097)

The AI capability ([[0097-ai-assistant-mcp-and-headless-api|ADR-0097]]) adds **no new principal kind and
no parallel permission map**. It adds three ways for an existing principal to reach the same routes, and
the tightest possible gate on each. The binding rules are [[INVARIANTS]] INV-AI-1…17.

### 9.1 Delegated identity — the AI acts as the principal

Every AI tool calls a real controller handler, wrapped with Nest's `ExternalContextCreator`, on a
synthetic request. The identity rides a **module-private `Symbol()`** (`auth/delegated-identity.ts`), and
`JwtAuthGuard` checks it **first**: `handleDelegated` re-loads the principal from the database through the
same `PrincipalLoaderService` as the network branches — a human live, at the expected epoch, active, not
directory-only; a Service Account including soft-deleted rows, refused when revoked, inactive or expired,
with its grants re-resolved. Then `MustChangePasswordGuard`, the permission guard, handler guards, pipes
and service checks run unchanged. No network request can own a symbol-keyed property, so the branch is
unreachable from HTTP (pinned by `jwt-auth.guard.delegated.spec.ts`).

Consequences for authorization:

- **A tool's permission is the route's.** Core derives it at boot from the primary binding's
  `@RequirePermission` and lists a tool only to a principal that holds it; the route re-checks at call time.
- **The channel gate is an extra AND.** `ai:use` (chat, headless) or `ai:connect` (MCP) — both MEMBER
  defaults, [[0046-roles-permissions-v2]] amendment — is re-read on every list, invoke, propose and approve.
- **A class ceiling narrows further.** Tools are `read` / `write` / `elevated` / `navigate`; the MCP
  scope or the SA's AI access setting caps which classes a call may use (below).
- **Chat writes need the owner's approval** on a server-built preview, with a password step-up derived
  from a closed warning list (role, identity, privilege, credential delivery, critical application).

### 9.2 OAuth scopes (MCP on HTTPS instances)

lazyit is its own OAuth 2.1 authorization server for `/mcp` (no OIDC). A grant carries the scopes the user
ticked on the consent page, and **the scope is a ceiling on the tool class, never a grant of permission**:

| Scope | Tool classes | Consent |
| --- | --- | --- |
| `lazyit.read` | `read` | offered |
| `lazyit.write` | `read`, `write` | offered, preselected |
| `lazyit.admin` | `read`, `write`, `elevated` | never preselected; the password is re-entered (shared step-up backoff, audited) |

Authority on every `/mcp` request = the user's **current** DB permissions ∩ the scope's classes, with
`ai:connect` and the MCP switch held now (`mcp/mcp-caller.ts` `scopesToCeiling`). A grant without a
ceiling fails closed to `read`. `navigate`-class tools (chat-only, e.g. `request_input`) are never listed
over MCP. Tokens are opaque and audience-bound to `/mcp`; they are refused on every REST route, and a
session JWT is refused on `/mcp`. A grant dies with the user's `mcpCredentialEpoch` (password change or
reset, admin reset or *revoke sessions*, deactivation, offboarding) — **not** with a normal web logout.

### 9.3 Personal MCP tokens (`lan` instances)

A plain-HTTP `lan` instance has no authorization server (the MCP spec requires HTTPS for it), so a user
holding `ai:connect` mints **personal tokens** (`lzit_pat_…`) in `/account/ai`: humans only, mandatory
expiry (90 days by default, 365 max), at most 20 live per user, scopes `lazyit.read` / `lazyit.write`
only — **never `lazyit.admin`**, so elevated tools are out of reach on `lan`. A personal token is an
`OAuthGrant` of kind `personal`: the same `mcpCredentialEpoch` binding, the same connected-apps list, the
same revocation. It is refused on an HTTPS instance, and an OAuth token is refused on `lan`.

### 9.4 Service Accounts — headless and on `/mcp`

A Service Account reaches the AI with its own `lzit_sa_` token, verified by the shared
`ServiceAccountAuthenticator` (REST and `/mcp` alike). Its limits ([[0048-service-accounts]] amendment):

- **Headless** (`POST /ai/runs`, `ai:use`): autonomous within its grants — no approval, no step-up — every
  write attributed to the SA in `ai_action_log`. `/ai/conversations` is human-only (403).
- **MCP** (`ai:connect`, fail-closed): no OAuth, the SA token is the credential.
- **Per-SA AI access** (`/config/ai/service-accounts/:id`, `settings:manage`, human-only, audited):
  `off` / `read-only` (ceiling `read`) / `read-write` (the default), and an optional mutation cap that
  counts changes (a batch's rows), per run headless and per rolling hour over MCP.
- **Never, whatever the grants:** AI access for an SA holding `infra:report`; workflow authoring,
  connections or enabling (INV-AI-17); a write on a critical application (refused over MCP and headless);
  provider web search; the elevated tools behind the SA-ungrantable verbs.

### 9.5 What no channel exposes

The Secret Manager, the operations that return a credential in cleartext (SA token create/rotate,
temporary passwords), the AI's own configuration (`/config/ai*`) and any generic egress tool are
**structural exclusions** (INV-AI-14): no tool can bind them, whatever the principal holds. The AI's
configuration itself is `settings:manage` + `ServicePrincipalForbiddenGuard`.

Related: [[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[0040-rbac-roles]] ·
[[0043-zitadel-source-of-truth]] · [[auth-zitadel-sot]] · [[INVARIANTS]] · [[shared-package]] ·
[[role-permission]] · [[service-account]] · [[user]] · [[0097-ai-assistant-mcp-and-headless-api]] ·
[[ai-assistant/_synthesis]]
