---
title: "ADR-0040: Minimal RBAC — ADMIN / MEMBER / VIEWER role on User"
tags: [adr, auth, authz, rbac, security]
status: accepted
created: 2026-06-01
updated: 2026-06-01
deciders: [Joaquín Minatel]
---

# ADR-0040: Minimal RBAC — ADMIN / MEMBER / VIEWER role on User

## Status

accepted — 2026-06-01 (CEO decision). Builds directly on [[0038-jit-user-provisioning]] (the global
`JwtAuthGuard` that AUTHENTICATES every request and JIT-provisions a `User`) and supersedes the
authorization side of [[0016-auth-strategy-deferred]]. This is the authorization layer that ADR-0038
deliberately did not add: ADR-0038 sets `request.user`, ADR-0040 decides **what that user may do**.

## Context

The May 2026 review's #1 finding: lazyit had **authentication but no authorization**. The global
`JwtAuthGuard` only *authenticates* (validates the OIDC JWT or the `X-User-Id` shim and sets
`request.user`); it never checks *what the user is allowed to do*. The only authZ in the whole API
was the KB author-only write check inside `articles.service.ts`. Concretely, **any** logged-in user
could:

- self-grant `admin` access on an `isCritical` application (`POST /access-grants`),
- revoke anyone's access (`PATCH /access-grants/:id/revoke`),
- soft-delete / offboard any user (`DELETE /users/:id`, `POST /users/:id/offboard`),
- destructively soft-delete any asset, application, article, consumable, etc.

For the target operator (a 5–20-person IT team) the IdP is the *who-gets-in* gate (ADR-0038's
trusted-IdP assumption). What was missing is a *what-can-they-do* gate **inside** lazyit. The review
asked for the minimal model that closes the hole without inventing a configurability project.

## Considered options

- **Option A — Single coarse role on `User` {ADMIN, MEMBER, VIEWER}** (recommended). One enum column,
  a `@Roles()` decorator and a `RolesGuard` composed after the auth guard. Gate Access-grant writes,
  Users administration and destructive deletes to ADMIN; everything else stays as it is for
  authenticated members; VIEWER is read-only. No per-resource permissions.
- **Option B — Per-resource ACL / permission matrix.** Fine-grained permissions per entity/action,
  optionally per-record ownership. Far more power, far more surface: a permissions table, a policy
  engine, admin UI to manage it, and an ongoing "who can do what" maintenance burden — all for a
  5–20-person single-org team. Explicitly **rejected**.

## Decision

**Option A — a single coarse-grained `Role` enum on `User`** (CEO decision, quoted verbatim):

> RBAC = "ADMIN/MEMBER/VIEWER (Rec.)": a single Role enum on User {ADMIN, MEMBER, VIEWER}; default
> MEMBER; first JIT user / seed = ADMIN; `@Roles` + a RolesGuard composing AFTER the auth guard; gate
> Access writes, Users, and destructive deletes to ADMIN; resist any per-resource ACL matrix.

Concretely:

1. **Schema** — `enum Role { ADMIN MEMBER VIEWER }` and `role Role @default(MEMBER)` on `User`
   (migration `rbac_user_role`). The default is MEMBER, so any unspecified path lands on the least
   privileged *writeable* role (not ADMIN).
2. **First user is ADMIN** — a fresh install must always have someone able to administer it:
   - the **seed** (`apps/api/prisma/seed.ts`) upserts an ADMIN user (email overridable via
     `SEED_ADMIN_EMAIL`, default `admin@lazyit.local`);
   - the **JIT** path (`jwt-auth.guard.ts`) makes the **first user ever provisioned** ADMIN: it
     counts existing users (including soft-deleted, so "ever") and, only when the count is 0, sets
     `role = ADMIN` in the `create` of the existing race-safe `upsert`-on-`externalId`. Every later
     JIT user defaults to MEMBER. The check-then-create window is acceptable: it only matters on a
     truly empty DB, and the worst case (two genuinely-concurrent first logins) makes both ADMIN —
     strictly safer than locking everyone out, and an ADMIN can demote.
3. **Primitives** — `@Roles(...Role[])` decorator (`auth/roles.decorator.ts`) records the allowed
   roles; `RolesGuard` (`auth/roles.guard.ts`) enforces them. Both are registered as `APP_GUARD` in
   `AuthModule` **in order**: `JwtAuthGuard` first (sets `request.user`), `RolesGuard` second (reads
   it). NestJS runs multiple `APP_GUARD`s in registration order, so the ordering is load-bearing.
4. **RolesGuard semantics**:
   - `@Public()` route → skip authZ entirely (mirrors the auth guard short-circuit; health probes).
   - No `@Roles()` metadata (or an empty set) → **allow any authenticated user**. This preserves the
     pre-RBAC behaviour: adding RBAC does not silently lock down unannotated routes; an endpoint is
     only restricted when it explicitly opts in.
   - `@Roles(...)` present → allow iff `request.user.role` is in the set, else **403 Forbidden**.
   - A `@Roles()`-gated route with no authenticated actor (shim anonymous) → 403 (a missing actor can
     never satisfy a role). The guard never throws 401 — authentication is the auth guard's job.
5. **Shared contract** — `RoleSchema` (zod enum) + `Role` type in `@lazyit/shared`, mirroring the
   Prisma enum exactly; `role` added to the `User` response schema; `role` accepted (optional) on
   `CreateUser`/`UpdateUser`. Accepting `role` on those payloads is safe **only because the Users
   controller is ADMIN-gated** — a non-admin never reaches it, so a non-admin can never set or
   escalate a role (no self-promotion path exists).

### Role → capability matrix

| Capability (endpoint group) | ADMIN | MEMBER | VIEWER |
| --- | :---: | :---: | :---: |
| Read everything (all `GET`) | ✅ | ✅ | ✅ |
| **Access-grant writes** — create / revoke / patch notes / patch expiry | ✅ | ❌ | ❌ |
| **Users administration** — create / update (incl. `role`) / delete / offboard | ✅ | ❌ | ❌ |
| **Destructive deletes** — `DELETE` on assets, locations, applications, consumables, articles, and all category modules | ✅ | ❌ | ❌ |
| Inventory writes — create/update assets, models, locations, consumables, applications, categories | ✅ | ✅ | ❌ |
| Asset assignments — open / release / edit notes | ✅ | ✅ | ❌ |
| Consumable stock movements — IN / OUT / ADJUSTMENT | ✅ | ✅ | ❌ |
| KB writes — create / update / publish / unpublish / import (author-only still enforced in the service) | ✅ | ✅ | ❌ |
| KB **delete** (destructive) | ✅ | ❌ | ❌ |
| Any mutation at all | ✅ | partial | ❌ (read-only) |

Mechanically: ADMIN-only endpoints carry `@Roles('ADMIN')`; ordinary writes carry
`@Roles('ADMIN', 'MEMBER')` (which both gives VIEWER read-only everywhere and blocks VIEWER from any
mutation); all `GET`s are unannotated (any authenticated user, including VIEWER).

### Notable nuances (review these)

- **Applications CRUD is MEMBER, not ADMIN.** Creating/editing an `Application` (incl. the
  `isCritical` flag) is treated as ordinary catalog/inventory work; only **deleting** one is
  ADMIN-gated. The sensitive operation the review flagged — *granting access* — is the AccessGrant
  write, which **is** ADMIN-only. If the team later wants Application edits to be admin-only too, flip
  the two decorators on `applications.controller.ts`.
- **KB delete is now ADMIN-only**, a behaviour change: previously a draft author could soft-delete
  their own article. Per the CEO directive "all destructive DELETE endpoints across modules → ADMIN",
  article deletion now requires ADMIN. The author-only check in `articles.service.ts` still governs
  *non-delete* edits/publishes (a MEMBER can still only touch their own drafts).
- The decorator is intentionally placed *after* the HTTP-verb decorator on each method
  (`@Post()` then `@Roles(...)`); decorator order is irrelevant to NestJS metadata, both run.

## Consequences

- **Positive:**
  - The review's #1 finding is closed: a MEMBER can no longer self-grant access, revoke others, or
    administer/offboard users; a VIEWER cannot mutate anything.
  - Enforcement is global and declarative (`@Roles()` + a single guard), composing cleanly on top of
    ADR-0038 with no per-service plumbing.
  - First-user-ADMIN means a fresh install (seed or first OIDC login) is never left un-administrable.
  - Privilege management is itself an ADMIN-only operation, so there is no self-escalation path.

- **Negative / trade-offs:**
  - Coarse-grained: no per-record or per-resource permissions. Accepted for the 5–20-person target
    (Option B explicitly rejected). A larger or multi-tenant deployment would need a richer model.
  - The first-user-ADMIN JIT check is check-then-create, not transactional. Bounded to an empty DB;
    the worst case over-grants (both concurrent first logins become ADMIN), never under-grants.
  - KB-delete becoming ADMIN-only is a UX change for authors (see nuance above).

- **Follow-ups (out of scope here):**
  - Frontend role-aware UI (hide admin actions for non-admins) — a separate web PR; the API is the
    enforcement boundary regardless.
  - **Soft-delete restore** endpoints will be ADMIN-gated by the same `@Roles('ADMIN')` mechanism in
    the next stacked PR (Round-2 #2).
  - A "last ADMIN" guard (refuse to demote/offboard the final ADMIN) is a sensible future safeguard;
    not implemented now.

Related: [[0038-jit-user-provisioning]] · [[0016-auth-strategy-deferred]] ·
[[0022-draft-visibility-auth-shim]] · [[0023-access-management-design]] · [[user]]
