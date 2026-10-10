---
title: User
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-10-09
---

# User

> 🟢 implemented · Area: People · Implementation order: 1 (atomic, no dependencies)

## Purpose

A person in the organization. **Central to access, peripheral to assets** ([[asset-centric]]):
users come and go while assets persist, so the model attaches users *to* assets rather than
the reverse.

## Relationships

- **owns** N [[asset]]s via [[asset-assignment]] (with history).
- **holds** N [[access-grant]]s to [[application]]s.
- **raises** N [[access-request]]s.
- **receives** N consumable **deliveries**: `OUT` [[consumable-movement]]s whose `targetUserId` is this
  user. A delivery of a *returnable* consumable stays outstanding until it is returned.
  - List them with `GET /consumables/deliveries?targetUserId=` (`outstandingOnly`, `from`/`to`, paged).
    This also needs `user:read`, so a VIEWER gets 403, the same directory-relational rule as
    `GET /users/:id/assignments`.
  - **Offboarding does not move stock or close deliveries.** The offboarding sheet and the Return Act
    list the leaver's deliveries so the team can ask for returnables back, and each return is recorded
    as it happens.
  - The FK is `Restrict`; a soft delete (offboarding) is unaffected
    ([[0098-consumable-delivery-targets]]).
- **has** an append-only [[user-history]] — its own lifecycle log (create / update / role change /
  manager change / offboard / restore / password-reset), the User counterpart of [[asset-history]]
  (DEBT-2, #185 — [[0050-user-history-and-activity-user-entity]]). A User is also the **actor** on
  history rows it caused (`performedById`).
- **reports to** at most one **manager** — either another lazyit User (self-FK `managerId`) or a
  free-text `managerName` fallback, and **has** N direct `reports` (the inverse self-relation). No
  cycles, no self-manage ([[0058-user-manager-and-clone-actions]]).

## Business rules

- Atomic entity — implemented first, alongside [[location]].
- Offboarding a user must not erase history: assignments and grants are *released*, not
  deleted (soft delete + lifecycle timestamps).
- **lazyit never writes to the IdP** ([[0102-remove-bundled-zitadel]]). Creating, editing and offboarding
  a user are database writes only. Under OIDC, offboarding blocks the person in lazyit (the soft delete;
  their next sign-in is refused — by `sub`, or by verified email when they never signed in, ADR-0102 §5)
  but does **not** disable their IdP account — that is the operator's step in their own IdP. Restore is the
  way back. No `User` row is ever hard-deleted.
- **Auditable lifecycle (DEBT-2, #185):** every User write emits an append-only [[user-history]] row
  **transactionally** with the change — `CREATED` on provisioning, `UPDATED` on a profile edit (name, email,
  legajo, username), `DEACTIVATED` / `REACTIVATED` on a real `isActive` flip (issue #1375), `ROLE_CHANGED` (payload `{ from, to }`) on a role change, `MANAGER_CHANGED` (payload `{ from, to }`,
  each side a user-id / external-name / null — [[0058-user-manager-and-clone-actions]]) on a manager
  change, `DELETED` on offboard, `RESTORED` on re-onboard, `PASSWORD_RESET_SENT` when a reset link is sent to the
  subject by lazyit's SMTP on the local `email` delivery (older rows record an IdP-triggered reset from
  before [[0102-remove-bundled-zitadel]] and stay readable),
  `PASSWORD_RESET_BY_ADMIN` when an admin mints a local temp-password instead
  (`AUTH_MODE=local`, [[0086-local-authentication-mode]] §5), and — self-service in local mode ([[0086-local-authentication-mode]] §F4) — `PASSWORD_CHANGED` when the user changes their own password and
  `PASSWORD_RESET_COMPLETED` when they reset it via a forgot-password email token. This supersedes the fire-and-forget structured log lines for *durability*: those
  logs remain, but the queryable trail now lives in the DB and surfaces in the
  [[recent-activity]] feed (`entityType = 'user'`).
- **Identity / auth:** the local User is the source of truth for the domain. `AUTH_MODE` is a
  three-state, instance-immutable choice ([[0086-local-authentication-mode]]): in `oidc` mode
  authentication is delegated to an external IdP whose `sub` maps to `externalId` and the guard
  JIT-provisions a User on first login ([[0038-jit-user-provisioning]]); in `local` mode lazyit owns
  the credential directly — `passwordHash` (argon2id), `passwordUpdatedAt`, `sessionEpoch` (token-version
  revocation) and `mustChangePassword` on the User row, provisioned by `/config/setup` (first admin) and
  admin create/reset (never JIT, no IdP). `AUTH_MODE=shim` keeps the `X-User-Id` header path for dev/test.
  Imported / directory-only rows land `passwordHash=null` and cannot log in until an admin provisions one.
  **Self-service password lifecycle (local mode, [[0086-local-authentication-mode]] §F4):** `POST /auth/change-password`
  (authenticated — verifies the current password, sets the new one, **bumps `sessionEpoch`**, clears
  `mustChangePassword`), plus the public `POST /auth/forgot-password` (enumeration-safe; mints a single-use
  SHA-256-hashed reset token, ≤1h TTL, in `PasswordResetToken`, and emails the link if SMTP is configured)
  and `POST /auth/reset-password` (consumes the token, sets the new password, bumps the epoch, invalidates
  sibling tokens). A `mustChangePassword=true` user is **walled off** from every non-exempt route with a
  `403 { code: 'PASSWORD_CHANGE_REQUIRED' }` until they change it (exempt: change-password, `GET /users/me`,
  `POST /auth/logout`, public routes).
  **Session lifetime (local mode, [[0086-local-authentication-mode]] §8):** a default sign-in lasts 12h; a
  "keep me signed in" sign-in (`rememberMe`) has **no time-based expiry**. Login and change-password report
  the token's `expiresAt` (`null` for no expiry). Either kind ends when `sessionEpoch` is bumped — sign-out
  (`POST /auth/logout`, which ends the user's sessions on every device), password change or reset, admin
  reset, **deactivation** (an active→inactive update), **offboarding**, and the AD/LDAP sync's **soft
  offboard** of an active person (#1308) — so reactivating or restoring a user, by hand or by the sync,
  never revives an old session. The guard also refuses an inactive, soft-deleted or `directoryOnly`
  row on every request.
  **Per-device sessions (local mode, [[0086-local-authentication-mode]] §9, #1420):** every sign-in also
  records a [[user-session]] row (browser, IP, dates, remember-me), and its token carries the row id.
  `GET /auth/sessions` lists the caller's own live sessions (`current` flagged) and
  `DELETE /auth/sessions/:id` ends one device without touching the others. `POST /auth/logout` stays
  "sign out everywhere": it bumps `sessionEpoch` **and** deletes every session row. Tokens issued before
  the upgrade have no row and keep the epoch-only check.
  **MCP credentials have their own counter.** `mcpCredentialEpoch` (`int`, default 0) is what every
  [[oauth-grant]] (OAuth connection or personal MCP token) snapshots. Every lever above bumps it together
  with `sessionEpoch` — password change or reset, admin reset (and the admin *revoke sessions* option),
  the recovery CLI, deactivation, offboarding, the sync's soft offboard — **except sign-out**:
  `POST /auth/logout` ends web sessions only and leaves the user's MCP connections alive
  ([[0097-ai-assistant-mcp-and-headless-api]] decision 8, amended 2026-09-24).
- **Authorization (Roles & Permissions v2):** the three roles stay **fixed** —
  `enum Role { ADMIN MEMBER VIEWER }` is unchanged ([[0040-rbac-roles]]) — but what each role *grants*
  is now a configurable set of **fine-grained permissions** ([[0046-roles-permissions-v2]]). A privilege
  decision asks **"does the caller's role hold permission `domain:action`?"**, resolved **DB-first** from
  the [[role-permission]] rows ([[INVARIANTS]] INV-8) — never from a token claim. Enforcement is a
  **single primitive**, `@RequirePermission(...)` + the permission guard (composing after the auth
  guard); the legacy coarse `@Roles()` gate from ADR-0040 is **retired**.
  - **ADMIN** holds the COMPLETE catalog and is **immutable/full** (never editable), so an ADMIN is
    always omnipotent and the last-admin / first-admin invariants stay intact.
  - **MEMBER** holds every `:read` + `:write` (ordinary inventory / KB / asset operations); **VIEWER** is
    read-only **except** it can no longer read the access map (`accessGrant:read`) or the user directory
    (`user:read`) — those two reads are pre-tightened to ADMIN + MEMBER (the read-authz gap closed).
  - **MEMBER / VIEWER are fully configurable** by an ADMIN within the catalog (an admin may delegate a
    `:delete` or a coarse verb; the UI warns ⚠ but the server accepts it). Permissions are
    **lazyit-local** — never sent to the IdP ([[0102-remove-bundled-zitadel]]). See
    [[role-permission]].
  - The **first** user ever provisioned (seed or first JIT login) is `ADMIN`; everyone else defaults to
    `VIEWER` (least-privilege; flipped from `MEMBER` by [[0043-zitadel-source-of-truth]] Phase 1). Only an
    ADMIN can change a role (Users administration is gated `user:manage`, ADMIN-only in the seed), and no
    user can change their own role — so there is no self-escalation path.

## Conventions

- **ID:** `uuid()` — sensitive / externally-exposed entity ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.
- **Wire shape is an allowlist ([[SEC-085-user-credential-columns-serialized\|SEC-085]]):** a User leaves the API
  only through `PUBLIC_USER_SELECT` (`apps/api/src/users/public-user.ts`) — the `UserSchema` columns plus
  the resolved `manager` descriptor. Every `/users` response goes through `serializeUsers`, and a relation
  that embeds a User uses `include: { user: { select: PUBLIC_USER_SELECT } }`, never `user: true`.
  `passwordHash`, `passwordUpdatedAt`, `sessionEpoch`, `mcpCredentialEpoch`, `mustChangePassword`,
  `notificationEmailOptOutTypes`, the raw manager columns and the AD reconcile keys never reach a client.
  A new column stays server-side until it is added to both `UserSchema` and the allowlist.

## Fields

Implemented in `apps/api/prisma/schema.prisma` (`User` → table `users`). Validation schemas
(`UserSchema`, `CreateUserSchema`, `UpdateUserSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/user.ts`) and are the source of truth for both api and web
([[shared-package]], [[0013-zod-validation-pipe]]).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | `@default(uuid())`, `@db.Uuid` — sensitive/exposed ([[0005-id-strategy]]). |
| `email` | `string` | Required, **case-insensitive** (`@db.Citext`, [[0041-soft-delete-reuse-and-restore]]). Unique among **live** rows only — a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL in the migration; no `@unique`), so a soft-deleted email is freed for reuse / restore. Write payloads normalize it (trim + lowercase). |
| `firstName` | `string` | required. |
| `lastName` | `string` | required. |
| `isActive` | `boolean` | `@default(true)`. Activation flag — see note below. |
| `role` | `Role` | `@default(VIEWER)` (flipped from `MEMBER` by [[0043-zitadel-source-of-truth]]). The fixed role `ADMIN` / `MEMBER` / `VIEWER` ([[0040-rbac-roles]]); what each role *grants* is the configurable [[role-permission]] matrix ([[0046-roles-permissions-v2]]). First user ever provisioned = `ADMIN`; all others default to `VIEWER`. |
| `externalId` | `string?` | `@unique`, nullable. Holds the IdP `sub`; populated on first OIDC login ([[0038-jit-user-provisioning]]); `null` for unlinked users ([[0016-auth-strategy-deferred]]). |
| `legajo` | `string?` | Employee/file number (LATAM payroll/HR), [[0058-user-manager-and-clone-actions]]. Optional, stored verbatim (trimmed on write). Unique among **live** rows only — a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL; no `@unique`), so offboarding frees it for reuse/restore (the `email` precedent, [[0041-soft-delete-reuse-and-restore]]). |
| `username` | `string?` | Directory/display handle distinct from `email`/`externalId`, [[0058-user-manager-and-clone-actions]]. Optional, normalized (trim + lowercase) so `Ana`/`ana` collide. Same live-only partial unique index. **NOT an auth credential** and **never** an account-linking key (that stays `email`/`externalId`, INV-2). |
| `managerId` | `uuid?` | The manager when they ARE a lazyit user — self-FK → `User`, `onDelete: SetNull` ([[0058-user-manager-and-clone-actions]]). Mutually exclusive with `managerName` (DB CHECK `users_manager_at_most_one`; both-null = no manager). A DB CHECK `users_manager_not_self` forbids self-manage; the service also rejects a **cycle** (DFS up the chain). A soft-deleted linked manager is surfaced as `isOffboarded` on read, never a dangle. |
| `managerName` | `string?` | Free-text fallback when the manager is **not** a lazyit user, [[0058-user-manager-and-clone-actions]]. Normalized (trim). Mutually exclusive with `managerId`. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | Soft delete — `null` while live; reads filter `deletedAt: null` ([[0006-soft-delete-and-auditing]]). |
| `directoryOnly` | `boolean` | `@default(false)`. `true` = a **directory person** created by the bulk import ([[0069-migrator-import]] §A.3): no login, role forced VIEWER, `externalId` stays `null`. Flips to `false` on first OIDC login (JIT promotion, [[0038-jit-user-provisioning]] amendment) or, in local mode, via `POST /users/:id/provision-local-account` (ADMIN onboarding). See **Directory mode** note below. |
| `directoryAttrs` | `json?` | Free-form directory attributes (`jobTitle`, `department`, `phone`, and any person sub-field without a native column) for `directoryOnly = true` rows. Same posture as `Asset.specs` (ADR-0007): jsonb, optional, only populated on directory rows. Not validated per-field in MVP. Upgrade path: promote to real columns if SQL filter/sort by field is needed. The AD/LDAP reconcile ([[0091-on-prem-ad-ldap-directory-source]]) also stashes `mail`/`username` **hints**, the entry's `memberOf` group DNs **inert** (#846), and a `lastSeenAt` heartbeat here. |
| `directorySource` | `string?` | AD/LDAP directory-source discriminator ([[0091-on-prem-ad-ldap-directory-source]]): `"ad"` for a person reconciled from an on-prem AD/LDAP directory; `null` for a login user or an import-sourced directory person. Mirrors infra `reportingSource` (a string, not a bool) so a second source can coexist additively. |
| `directorySourceId` | `string?` | The AD `objectGUID` (canonical GUID string) — the **immutable natural key** the reconcile upserts on ([[0091-on-prem-ad-ldap-directory-source]]). **Never `externalId`** (that is the OIDC-sub/account-linking key, INV-2). Live-scoped **partial unique** (`WHERE "deletedAt" IS NULL AND "directorySourceId" IS NOT NULL`, raw SQL in the migration, ADR-0041). |
| `locale` | `string?` | Per-user UI language (issue #1422) — `en` \| `es` (`UiLocaleSchema`), validated on write; `null` = never chosen (every pre-existing row). A stored value outside the catalog reads as `null`. No DB enum. See the preferences note below. |
| `theme` | `string?` | Per-user colour theme (issue #1422) — `light` \| `dark` \| `system` (`ThemePreferenceSchema`); same null/tolerant-read rules as `locale`. |
| `directoryOffboardedAt` | `datetime?` | Set when an **active** AD-sourced person **disappears** from the directory past the configurable grace threshold: a **soft** offboard (`isActive=false` + this stamp), **never** a hard delete (ADR-0006). The offboard also bumps `sessionEpoch`, revoking their local sessions (#1308). Cleared if the person reappears in a later sync, which reactivates them without restoring any session ([[0091-on-prem-ad-ldap-directory-source]]). The stamp means *the sync* deactivated them, so it is the only deactivation the sync ever undoes: a person who is already inactive (deactivated by hand) is never stamped and stays inactive when they reappear, and a manual deactivation clears any stamp left from an earlier sync offboard (#1311). The sync never offboards the **last active ADMIN**: that person is skipped with a warning until another active ADMIN exists (SEC-021). |
| `directoryReenabledAt` | `datetime?` | Set when an admin re-enables a person by hand (`PATCH /users/:id`, inactive→active); cleared by a manual deactivation. While it is set, the directory sync never offboards the person, whatever their history, so an admin's re-enable holds while they stay missing from the directory (#1522, [[0091-on-prem-ad-ldap-directory-source]]). The sync clears it, and any leftover `directoryOffboardedAt` on the now-active person, when they reappear in the directory, so a later absence past grace offboards them as usual. Server-side only, never serialized (same posture as `directoryOffboardedAt`). `NULL` on every row that predates the column. |

> [!note] Manager identity graph + clone-with-chosen-actions ([[0058-user-manager-and-clone-actions]])
> The read `UserSchema` resolves the manager FK to a **redaction-safe descriptor** —
> `{ type:"user"; id; firstName; lastName; isOffboarded } | { type:"external"; name } | null` — never
> the raw `managerId`/`managerName` columns (so a deleted manager surfaces `isOffboarded:true`, never a
> leak/dangle). Create/Update accept a `manager` **input union** (`{ managerId }` xor `{ managerName }`
> xor `null`) mirroring the DB CHECK, plus optional normalized `legajo`/`username`. A manager change
> emits a **`MANAGER_CHANGED`** [[user-history]] row (payload `{ from, to }`, each side a user-id /
> external-name / null). **`POST /users/:id/clone`** mints a NEW user (a normal create — never copies the
> source's email/legajo/username or `externalId`) and mirrors the source's **selected** active
> [[asset-assignment]]s + [[access-grant]]s as **new** append-only rows for the new user (actor = the
> cloning admin). The **engine toggle** `fireWorkflowsOnClonedGrants` (default **false**, safe-by-default)
> decides whether each cloned grant fires the [[0054-applications-workflow-engine|workflow engine]]
> (`ACCESS_GRANTED`, after commit) or is recorded bookkeeping-only; the choice is audited in the clone's
> CREATED history. Response is the per-item batch shape `{ created, skipped: [{ id, reason }] }`. **Out of
> scope (separate follow-up):** the mapper `grantee.manager`/`legajo`/`username` token group.

> [!note] `isActive` vs `deletedAt` — independent concepts
> `isActive = false` means the person is **offboarded/disabled but retained** (past
> assignments and access grants still reference them) — this is the offboarding rule above. `deletedAt` means the
> record is **soft-deleted** (hidden from normal queries). A user can be inactive yet not
> deleted. Creation always starts active; deactivation is a `PATCH`. An inactive account cannot
> authenticate, so deactivation strips administrator powers like a demotion does: deactivating the
> **last active ADMIN** is refused (409), and the last-admin guard counts only live, active ADMINs
> ([[0040-rbac-roles]], SEC-021).

> [!note] Directory mode — `directoryOnly = true` ([[0069-migrator-import]] §A.3 / [[INVARIANTS]] INV-DIR)
>
> A **directory person** is a `User` row created by the bulk import for an asset's "Assigned to" field.
> It has no login. Key rules:
>
> - `role = VIEWER` (forced; the import schema rejects any other value).
> - `externalId = null` always (the import never sets it; SEC-006 blocks it from the API too).
> - `isActive = true` (set on creation; offboarding proceeds normally — see below).
> - Email: may be a real address OR a synthesized `<sessionId>-<rowIndex>@directory.local` placeholder
>   when the row's only identity key is legajo or username. A placeholder email means the person can
>   **never** auto-promote via OIDC.
> - Identity dedup: the import deduplicates by **email, legajo, or username** (in that priority order)
>   against **live rows only** (`deletedAt: null`). Soft-deleted rows are invisible and are never
>   resurrected.
> - **Ambiguous identity:** if the import row's keys match two or more distinct live users, the asset
>   is imported unassigned with an `ambiguous-identity` warning. No person is linked.
>
> **Capability rules (enforced as invariants — see [[INVARIANTS]] INV-DIR):**
> - A directory person is **never** the subject of an `AccessGrant`.
>   `AccessGrantsService.assertUserUsable` rejects `directoryOnly = true` rows with 400.
> - A directory person is **never** counted in the bootstrap first-user→ADMIN logic
>   (`jwt-auth.guard.ts` filters `directoryOnly: false` in the bootstrap count).
> - A directory person **IS** a valid target for `AssetAssignment` (that is its purpose).
> - A directory person participates in the **same offboarding cycle** as any User: soft-deleting it
>   releases its active assignments via `releaseAllForUser`.
>
> **Promotion to a full account:**
> - **Auto (JIT):** when the person logs in via OIDC with the same verified email, the standard JIT
>   claim path (`jwt-auth.guard.ts`) binds `externalId = sub` and sets `directoryOnly = false`.
>   The person inherits their existing `role` (VIEWER) and all prior assignments.
> - **No manual OIDC promotion.** `POST /users/:id/provision-account` (which created the account in the
>   bundled Zitadel) was removed with it ([[0102-remove-bundled-zitadel]]): under OIDC the person is created
>   in the operator's IdP and claims the row on first sign-in (the JIT path above). A placeholder
>   `@directory.local` email can never be claimed. `GET /config/status` keeps emitting
>   `canProvisionAccounts: false` so an older web build keeps hiding the action. Historical
>   [[user-history]] rows with `payload.action = 'provisionAccount'` stay as written and readable.
> - **Manual (ADMIN, local):** `POST /users/:id/provision-local-account` (issue #1072, [[0086-local-authentication-mode]]
>   §5 amendment) onboards a directory person in `AUTH_MODE=local`: it mints a one-time temp password with the
>   admin-reset primitives (`generateTempPassword` + `credentialFields({mustChangePassword:true})`), flips
>   `directoryOnly = false`, appends an `UPDATED` history row, and returns the plaintext **once**
>   (`AdminPasswordResetResult`). The existing `role` is kept (**no widening**), it's ADMIN-action-gated (no
>   self-service), and it **400s outside local mode**. `GET /config/status` exposes **`canProvisionLocalAccounts`**
>   (true only in local mode) so the web offers the "Onboard with a temporary password" action there instead of
>   the impossible OIDC one. This is the one path that amends INV-DIR's "never receives a credential".
>
> **Visibility:** directory persons appear in `GET /users` mixed with accounts, tagged `directoryOnly: true`.
> The web shows a "Directorio" badge. `GET /users?directoryOnly=true` lists only directory persons.
>
> **AD/LDAP as a directory SOURCE** ([[0091-on-prem-ad-ldap-directory-source]], #839): besides the bulk
> import, `directoryOnly` persons can be **reconciled read-only** from an on-prem AD/LDAP directory. A
> singleton `DirectoryConnection` (Settings → Directory, `settings:manage`, off by default) binds
> read-only, subtree-searches, and **upserts** persons keyed on `directorySourceId` (AD `objectGUID`) — via
> a `setInterval` sweeper and an ADMIN `POST /directory/sync` ("Sync now"). NEW → the PENDING tray (a
> `directoryOnly` VIEWER); MATCHED → refresh mapped profile fields + `directoryAttrs` (a fixed allowlist);
> DISAPPEARED past a grace threshold → soft offboard (bumping `sessionEpoch` when the person was active,
> #1308), never of a person an admin deactivated or re-enabled by hand (#1311, #1522). **Hard invariants:** the sync never changes `role`, never sets `passwordHash`/`externalId`,
> never flips `directoryOnly`→false, never grants a login, never hard-deletes, and writes `sessionEpoch`
> only as that offboard's revoking increment. JIT promotion and `provisionLocalAccount` stay the ONLY
> login-granting paths.

## Endpoints

`apps/api/src/users/` (`UsersModule`): `GET /users` (excludes soft-deleted; accepts `?directoryOnly`
and `?role` filters — `?role=ADMIN|MEMBER|VIEWER` scopes the list to one role, validated by
`RoleSchema` → 400 on an unknown value; backs the Settings → Roles "View N members" deep-link, issue
#693; `?isActive=true|false` scopes it to enabled or deactivated accounts — anything else → 400,
absent = both, issue #1375), `GET /users/role-counts` (per-role LIVE counts `{ ADMIN, MEMBER, VIEWER }` from one Prisma
`groupBy` over the active directory — the Settings → Roles card counts; declared before `:id` so the
literal isn't parsed as a uuid; gated `user:read`), `GET /users/me`
(the current authenticated caller, **including their role** — declared before `:id` so the literal
`me` isn't parsed as a uuid; the OIDC token doesn't carry the lazyit role, so the web reads it here),
`PATCH /users/me` (the caller edits **their own first and last name** — see the self-service note below),
`GET` / `PUT /account/preferences` (the caller's language and theme — see the preferences note below),
`GET /users/:id`, `POST /users`, `POST /users/:id/clone` (clone-with-chosen-actions —
[[0058-user-manager-and-clone-actions]]; see the manager/clone note above), `PATCH /users/:id`,
`DELETE /users/:id` (soft delete), `POST /users/:id/offboard`, `POST /users/:id/restore` (re-onboard:
clears `deletedAt`; does NOT re-grant access or re-assign assets — [[0041-soft-delete-reuse-and-restore]]),
`POST /users/:id/reset-password` (admin-triggered password reset — see the profile edits and password
reset note below), and `POST /users/:id/provision-local-account` (ADMIN onboarding of a directory person in
local mode — see **Directory mode** note above).
All **write** endpoints (create / update incl. name/email/role / delete / offboard / restore /
reset-password) are gated `@RequirePermission('user:manage')` — ADMIN-only in the seed, **not**
`user:write` (which MEMBER holds) ([[0046-roles-permissions-v2]] P4). The directory **reads** `GET /users` and `GET /users/:id` (and the
nested reads below) are gated `@RequirePermission('user:read')` — ADMIN + MEMBER (a VIEWER gets 403;
this is the pre-tightening). `GET /users/me` stays OPEN (the self-read the web gates its UI off; the
OIDC token doesn't carry the lazyit role), and so does `PATCH /users/me` (a self-write of the caller's
own name only). Bodies validated against the
shared schemas and documented via Swagger ([[0018-api-documentation-swagger]]). Also
`GET /users/:id/assignments?activeOnly=` lists the assets assigned to the user ([[asset-assignment]])
and `GET /users/:id/access-grants?activeOnly=&includeExpired=` lists their application access
([[access-grant]]).

> [!note] `GET /users` list item — derived activity counts (issue #386)
> The `GET /users` LIST item is the full `UserSchema` (so it already carries the resolved `manager`
> descriptor + `legajo`/`username`, [[0058-user-manager-and-clone-actions]]) **plus two OPTIONAL,
> list-only activity counts** (`UserListItemSchema` in `@lazyit/shared`, `schemas/user-list.ts`):
> `assetsInPossession` (active [[asset-assignment]]s, `releasedAt IS NULL` — [[0019-asset-assignment-integrity]])
> and `appAccesses` (active [[access-grant]]s, `revokedAt IS NULL` — [[0023-access-management-design]]).
> They power the [[0030-list-pagination-contract|Users column picker]] (#386). Both are **batched per
> page** — `findPage` issues exactly **one Prisma `groupBy` per count** over the page's user ids (two
> queries total, never N+1) and attaches the result to each row (`0` when none). They are **optional +
> additive**: the single-user reads (`GET /users/:id`, `/me`, create/update) return the bare
> `UserSchema` and DON'T carry them, so existing consumers are unaffected. The page envelope itself is
> unchanged (ADR-0030 `Page<T>` — the counts ride on each row).

> [!note] Self-service name edit — `PATCH /users/me` (issue #1421)
> Any signed-in **human** — VIEWER included — may change **their own `firstName` and `lastName`, and
> nothing else** (CEO decision). The body is `UpdateOwnProfileSchema` in `@lazyit/shared`: a strict
> object with those two optional keys (at least one), same bounds as the admin edit; **any other key is
> a 400**. Email, role, legajo, username, manager and activation stay on the ADMIN-only
> `PATCH /users/:id` (`user:manage`). The subject is always the caller (the id comes from the
> principal, never the body), so there is no cross-user write and no permission gate.
> - **Directory-owned people are refused** with **409 `{ code: 'PROFILE_MANAGED_BY_DIRECTORY' }`**:
>   when `directorySource` is set the AD/LDAP sync owns the name and would overwrite the edit on the next
>   run ([[0091-on-prem-ad-ldap-directory-source]]). `UserSchema` now carries the optional
>   `directorySource` so the web can disable the form instead of offering a request that always fails.
>   (A `directoryOnly` person has no login and cannot reach the route; it is refused the same way.)
> - **Service accounts are refused** (403 — fail-closed on an unannotated route, INV-SA-2, plus a
>   handler backstop with `code: 'SERVICE_ACCOUNT_NOT_ALLOWED'`); a bot has no person record.
> - It runs through the **same update path as the admin edit**: the search index is refreshed and one
>   **`UPDATED { fields: ['name'] }`** [[user-history]] row is written with the **caller as actor**.
>   Resending the stored name is not a change and writes nothing. The name is local only (lazyit never
>   writes to the IdP, [[0102-remove-bundled-zitadel]]), and a later sign-in does **not** overwrite it — the JIT
>   path only refreshes a name that still looks like a seed placeholder ([[0038-jit-user-provisioning]]).

> [!note] Per-user language and theme — `/account/preferences` (issue #1422)
> The CEO chose **"the browser's value wins"**. `GET /account/preferences` returns `{ locale, theme }`
> (`UserPreferencesSchema`); `PUT /account/preferences` takes either key (`UpdateUserPreferencesSchema`:
> strict, at least one key; omitted = unchanged, `null` = back to never chosen). `GET /users/me` also
> carries `locale` and `theme`. Self-only (the id is the principal's), any signed-in human, no
> permission; service accounts get 403. **Precedence on the web:** the browser's own value (the
> `NEXT_LOCALE` cookie, next-themes' `localStorage`) wins; the stored value is applied **only** in a
> browser with no preference of its own; changing either in the UI also saves it here, so it follows the
> user to other devices ([[0051-i18n-next-intl]] amendment). **No [[user-history]] row** — a display
> preference is not a change to the person record (the same call as the email opt-outs, #879).

> [!note] RBAC safety guards (ADR-0040, Round 3)
> Changing a `role` is governed by two service-level guards. The API **refuses to remove the last
> remaining `ADMIN`** — demoting away from `ADMIN`, offboarding or deleting the final administrator
> returns **409 Conflict** — and **no user can change their own role** (**403 Forbidden**). Role
> management is otherwise done by an `ADMIN` from the **Users** section (a per-user role Select);
> the very first `ADMIN` on a pre-existing DB is set out-of-band via `bun run set-role` ([[auth-bootstrap]]).

> [!note] Admin profile edits and password reset (issue #149, [[0102-remove-bundled-zitadel]])
> `PATCH /users/:id` lets an `ADMIN` edit `firstName` / `lastName` / `email` (alongside `role`). The edit
> is a **plain database write**: nothing is written to the IdP, so there is no IdP failure to revert and
> no 503. The `email` is the **account-linking key** ([[INVARIANTS]] INV-2, `citext`) for a row not yet
> linked; once linked, sign-in matches on `externalId`, so an email change here does not touch the IdP
> account. `externalId` can never be set via the API (SEC-006).
> `POST /users/:id/reset-password` in **OIDC** mode returns an honest **501** ("managed by your identity
> provider") for every user: the operator's IdP owns the credential and its reset ([[INVARIANTS]] INV-4,
> [[0102-remove-bundled-zitadel]] §5) — never a misleading success. It is refused for an **inactive** user
> first (**422**) in both modes. In **`AUTH_MODE=local`** mode
> ([[0086-local-authentication-mode]] §5, amended by #1268) the admin chooses the **delivery** on an
> optional body `{ delivery, revokeSessions? }` — the body is optional so a pre-#1268 caller keeps today's
> behavior:
> - `temporary-password` (also the no-body default) mints a **one-time local temp-password**, hashes it
>   (argon2id), sets `mustChangePassword`, **always bumps `sessionEpoch`** (the stored hash was just
>   replaced, so a surviving session holds a dead credential), audits `PASSWORD_RESET_BY_ADMIN` and returns
>   **200** with `{ temporaryPassword }` (shown once).
> - `email` mints a single-use ≤1h `PasswordResetToken` and sends the link over the **instance SMTP**
>   ([[0079-instance-smtp-outbound-email]]), audits `PASSWORD_RESET_SENT`, and bumps `sessionEpoch` **only**
>   when `revokeSessions` is set (sending a link changes no credential). Unlike the enumeration-safe public
>   forgot flow this path reports honestly: **409** (`reason: smtp-not-configured | origin-unknown`) when the
>   link cannot be built or sent, **503** when the relay refuses.
>
> Both are refused for an inactive user or a **directory-only** person (**422**); directory-only rows never
> receive a credential via any path. `GET /users/password-reset-capabilities` (`user:manage`) publishes which deliveries are
> actually available, deliberately kept off the `@Public` `GET /config/status`.

> [!note] Create accepts an optional temporary password ([[0064-admin-user-provisioning-credentials]], #411)
> `POST /users` accepts an **optional** `password` on `CreateUserSchema` — a **temporary** credential for
> admin provisioning. It is honored **only in `AUTH_MODE=local`** ([[0086-local-authentication-mode]] §5): a
> supplied `password` is **hashed to `passwordHash`** (argon2id) with `mustChangePassword=true` (`externalId`
> stays null); omitting it lands a password-less row an admin can provision later. Under **OIDC** a supplied
> `password` is rejected with **400** *before any row is created* — the operator's IdP owns the credential
> ([[0102-remove-bundled-zitadel]] §5). Without a password an OIDC create is a plain row plus its `CREATED`
> history; the person claims it on first sign-in ([[0038-jit-user-provisioning]]). The password is **never
> persisted** in plaintext and **never logged/echoed** ([[0031-logging-strategy]] /
> [[0064-admin-user-provisioning-credentials]]). It reuses the existing **`user:manage`** gate (no new
> permission). Because `CloneUserSchema.profile` reuses `CreateUserSchema`, **`POST /users/:id/clone`
> accepts the same optional `password`** and handles it identically.

**Web:** `users/[id]` is the asset-centric **per-person** detail page (the counterpart to the asset
detail) — it composes the two nested reads above plus the user's authored [[article]]s, answering
"who can access what" for one person and cross-linking user ⇄ asset / application. It is a record page
(#1525, [[ledger-design-language]] §4b): counters for held assets, access and articles open their tab,
and an attention row flags access expiring within 30 days (the dashboard's default window), expired
access awaiting the sweeper, and unacknowledged assets. The held assets' labels come from
`GET /assets?assignedToUserId=` (complete at any inventory size); released-asset names resolve from a
catalog page only when the History tab opens. Grants are read only with `accessGrant:read`. See
[[0020-frontend-data-layer]].

Related: [[asset-assignment]] · [[access-grant]] · [[access-request]] ·
[[role-permission]] · [[service-account]] · [[asset-centric]] · [[shared-package]] ·
[[0013-zod-validation-pipe]] · [[0016-auth-strategy-deferred]] · [[0038-jit-user-provisioning]] ·
[[0040-rbac-roles]] · [[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[INVARIANTS]] ·
[[0069-migrator-import]] · [[0102-remove-bundled-zitadel]]
