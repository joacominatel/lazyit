---
title: "Sweep 2026-06-06 — Identity & Access Management pillar (users, user-history, access-grants)"
tags: [security, sweep, users, access-grants, iam, auth]
status: draft
created: 2026-06-06
---

# Sweep 2026-06-06 — IAM pillar (users · user-history · access-grants)

Deep audit of the Identity & Access Management pillar and its integration points. Method:
`.claude/skills/lazyit-sentinel/SKILL.md`. PoCs are **reasoned, not executed** (the API/DB are not
run, per engagement rules). Reserved range: **SEC-020…SEC-029** (used SEC-020, 021, 022).

## Scope

- `apps/api/src/users/**` — user CRUD, JIT interplay, offboard/restore, role changes + Zitadel
  write-back, password reset, last-admin/first-admin guards.
- `apps/api/src/user-history/**` — append-only `user_history` log + the recent-activity user branch.
- `apps/api/src/access-grants/**` — grant/revoke lifecycle, double-revoke 409, batch revoke, and the
  nested `/users/:id/access-grants` + `/applications/:id/access-grants` reads.
- Integration: the global `JwtAuthGuard` (shim + OIDC + service-account branches, JIT email linking),
  `RolesGuard` / `@RequirePermission` authz, `ActorService` attribution, the `recent_activity` view
  read in `dashboard.service.ts`, the shared zod schemas (`user.ts`, `access-grant.ts`, `permission.ts`).
- ADRs read: 0023, 0038, 0040, 0041, 0043, 0046, 0050; INVARIANTS INV-1..8, INV-SA-1..4; DEF-001..005;
  closed SEC-006.

## Findings

| ID | Sev | Module | One-liner |
| --- | --- | --- | --- |
| [[SEC-020-jit-email-link-no-email-verified\|SEC-020]] | 🔴 High | users | JIT email account-linking never checks `email_verified` → ADMIN/account takeover under BYOI (or unverified-self-reg Zitadel) |
| [[SEC-021-last-admin-lockout-via-isactive\|SEC-021]] | 🟠 Medium | users | `PATCH {isActive:false}` on the last ADMIN bypasses the last-admin guard → un-administrable lockout, no in-app recovery |
| [[SEC-022-isactive-not-rolled-back-on-idp-revert\|SEC-022]] | 🟡 Low | users | On an IdP write-back 503 the revert restores only role/name/email; a co-PATCHed `isActive` persists despite "change not saved" |

No Critical. **SEC-020 (High) is the headline** — it is the account-takeover-via-email-linking vector
called out for this pillar: the code enforces the *trusted-IdP* half of the linking model but not the
*verified-email* half that ADR-0038/INV-2/DEF-002 explicitly rely on.

## Verified-clean invariants (checked this sweep)

- **INV-2 (email linking) — partially.** Re-bind protection (a row linked to a different `sub` → 409),
  claim-only-when-`externalId IS NULL`, and soft-delete-filtered lookup (no resurrection) all hold and
  are race-safe (`updateMany` guarded by `{ id, externalId: null }` + refetch). **Gap:** the
  "verified email" premise is not enforced in code → SEC-020.
- **INV-1 / INV-8 (DB-first authZ).** `RolesGuard` resolves from `request.user.role` (DB row) via the
  permission resolver; never a token claim. Anonymous on a gated route → 403. Service principals are
  fail-closed (INV-SA-2) on unannotated routes.
- **INV-7 (default VIEWER / first ADMIN).** `create` defaults omitted role to VIEWER; JIT uses
  `userCount === 0 ? ADMIN : VIEWER` counting soft-deleted rows (no resurrection-to-ADMIN). Holds.
  (The last-admin *availability* side has a gap — SEC-021 — but the default/bootstrap roles are correct.)
- **INV-5 (write-back rollback/503) — mostly.** `create` hard-deletes on mirror failure; role/profile
  edits revert + 503 + best-effort name re-mirror; offboard deactivates IdP inside the tx. **Edge:** a
  co-PATCHed non-mirrored field (`isActive`) is not reverted → SEC-022 (Low).
- **SEC-006 (server-owned `externalId`).** `CreateUserSchema` / `UpdateUserSchema` are `strictObject`
  and omit `externalId`; the service never accepts it from the body. Still clean.
- **Mass assignment.** `access-grants.service` picks fields explicitly (never spreads the body), so
  actor FKs (`grantedById`/`revokedById`/`*SaId`) and `revokedAt` cannot be set from the body. `users`
  create/update spread only the strict, server-owned-field-free DTOs.
- **IDOR / nested-route scoping.** `/users/:id/access-grants`, `/users/:id/assignments` and
  `/applications/:id/access-grants` each `findOne()` the parent (404 on missing/soft-deleted) and scope
  the query to that id; all gated `accessGrant:read` / `user:read` (VIEWER 403, ADR-0046). No id-swap
  leak. `deleted=only` slice is ADMIN-gated at the controller (`assertCanListDeleted`, MEMBER 403).
- **Soft-delete consistency.** `users.findOne` / shim resolution / access-grant `assertUserUsable` use
  the filtered client (soft-deleted invisible); offboard soft-deletes in one tx (revoke grants +
  release assignments + DELETED history); restore via the `includeSoftDeleted` escape hatch.
- **Double-revoke / race.** `revoke` 409s an already-revoked grant; `batchRevoke` skips
  not-found/already-revoked per-id. Offboard's grant revoke is an idempotent `updateMany where
  revokedAt:null`.
- **SQLi.** The only raw SQL touching this pillar is the `recent_activity` read in
  `dashboard.service.ts` — fully parameterized via `Prisma.sql` / `Prisma.join` (filters, `ILIKE`
  pattern, `::uuid`/`::timestamptz` casts are all bound). No concatenation. Clean.
- **No command injection / eval / fs writes** in scope; **no secrets logged** (write-back audit lines
  log field names + ids, never passwords — lazyit never handles passwords, ADR-0016/0037).
- **user-history.** No read endpoint is exposed yet (the per-user timeline `list()` has no controller);
  the `recent_activity` user branch exposes only `summary`/`action`/`actorId`/`entityId` (no `payload`)
  and is gated `logs:read` (ADMIN-only, `ADMIN_ONLY_READS`). DELETED rows are filtered (live subjects
  only). No info leak.

## Integration risks / notes (not filed)

- **BYOI leaves every app-created user `externalId = null`** (`users.service.ts:164-175`) — this is what
  turns SEC-020 from "just the seed" into "any user is email-claimable" under BYOI. Captured in SEC-020.
- **Granting access to an `isActive=false` user is allowed** — `assertUserUsable` checks live (not
  soft-deleted) but not active. Inert (a deactivated user can't authenticate), so not filed; worth a
  guard if "active" ever gains independent meaning.
- **`grantedAt` is client-settable** on `POST /access-grants` (`CreateAccessGrantSchema`) — documented
  as intentional for backdating imported/historical records (ADR-0023), ADMIN-only, append-only ledger.
  Accepted, not a finding.
- **`restore` does not reactivate the IdP user** (offboard deactivates it) — fail-closed (the restored
  user can't get an OIDC token until reactivated); a functional/UX gap, not a security issue. Diverges
  slightly from ADR-0041's "exists and log in again" wording for the OIDC path; worth a doc note.
- **Swagger `entityType` enum on `GET /dashboard/activity` omits `user`** despite ADR-0050 widening the
  contract — a docs/OpenAPI mismatch only (the schema accepts `user`), not a security issue.

## Coverage / gaps

- Covered end-to-end: all three modules' controllers + services, both nested-route families, the auth
  guard's three branches and the JIT/email-link flow, the authz guard, actor attribution, the shared
  schemas, and the recent-activity raw read.
- Not exercised dynamically (API not run): the actual OIDC/userinfo round-trip and a live Zitadel
  Management failure (SEC-022's trigger) were reasoned from code. `jose` JWT verification internals and
  Zitadel adapter HTTP were not deep-audited (dependency phase).
- Out of scope: frontend (`apps/web`), dependency CVEs, deploy infra.
