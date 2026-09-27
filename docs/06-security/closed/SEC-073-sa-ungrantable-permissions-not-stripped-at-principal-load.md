---
id: SEC-073
title: A service account keeps SA-ungrantable permissions (user:manage, settings:manage) granted before SEC-011 — the principal loader never strips them
severity: medium
status: fixed
cwe: CWE-269
discovered: 2026-09-24
module: auth / service-accounts (authz) · ai (headless)
tags: [privilege-escalation, authz, service-accounts, rbac, upgrade-path, ai, adr-divergence]
---

# SEC-073 — SA-ungrantable permissions survive at principal load (INV-SA-3 not enforced for pre-existing grants)

## Summary

`resolveServiceAccountPermissions` filters a service account's grant rows by catalog membership only,
so a row for an **SA-ungrantable** verb persisted before the SEC-011 fix (2026-06-12), such as
`user:manage`, still ends up in the principal's permission set. SEC-011's runtime backstop
(`ServicePrincipalForbiddenGuard`) covers only some of the routes those verbs gate. `UsersController` is
not covered, so such an account can still create or promote an **ADMIN** over HTTP. Once the AI user
tools land, it can do the same from a headless run, with no approval and no step-up.

## Description

SEC-011 closed the SA escalation with two layers
([[SEC-011-service-account-coarse-meta-permission-escalation|SEC-011]] Resolution):

- **Layer 1** (the schema `.refine` plus `cleanPermissions`) stops **new** grants of
  `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS` (`settings:manage`, `user:manage`, `import:run`,
  `secret:read`, `secret:manage`). It runs on write only.
- **Layer 2** (`ServicePrincipalForbiddenGuard` / `HumanOnlyGuard`) is described as the backstop that
  "neutralises any pre-existing grant". It is applied **per controller or per route**. The
  service-accounts controller, `GET/PUT /config/permissions`, the import wizard and the Secret Manager
  have it. The Users routes do not.

Nothing between those layers strips an ungrantable verb when the principal is **built**. The loader
resolves grants DB-first (INV-1) and filters on catalog membership only:

```ts
// service-account-permissions.ts:19-24 — catalog filter only, no ungrantable filter
for (const { permission } of rows) {
  if (ALL_PERMISSIONS.has(permission as Permission)) resolved.add(permission as Permission);
}
```

`RolesGuard`'s service branch then authorizes on that set alone (`roles.guard.ts:82-90`). The result is
that a `service_account_permissions` row for `user:manage` written before 2026-06-12 is **fully
functional** on every route that lacks the Layer-2 guard:

| Route | Gate | Layer-2 guard |
| --- | --- | --- |
| `POST /users` (can set `role: ADMIN`) | `user:manage` | none |
| `PATCH /users/:id` (can change `role`) | `user:manage` | none |
| `POST /users/:id/reset-password`, `…/provision-account`, `…/provision-local-account`, `…/clone`, `…/offboard`, `…/restore`, `DELETE /users/:id` | `user:manage` | none |
| `PUT /article-categories/:id/access-rules` (KB folder ACL, INV-9) | `settings:manage` | none |
| `PUT /instance/update-settings` | `settings:manage` | none |

When the caller is a service principal, `ActorService.resolve(actor)` returns `undefined`, so the
self-role-change guard in `users.service.ts:982` (`actorId !== undefined && actorId === id`) is skipped.
Nothing in the user write path refuses a non-human caller.

**AI amplification (epic #1315).** The AI core runs a headless tool as the SA principal, which is
re-loaded through the same `PrincipalLoaderService` (`ai-tool.service.ts` `loadPrincipal`, reached from
`invoke`). On `HEADLESS`, `invoke` executes `write` and `elevated` tools directly. The only extra gates
are `ai:use` and the class ceiling, and `effectiveCeiling` returns **no ceiling** for headless unless
the SA's AI access setting sets one (`ai-tool.service.ts:74-79`, `tool-descriptor.ts:70-73`). The
approval card and password step-up of [[ai-assistant/security|AI security]] §6.2 apply only to the chat
channel. Boot validation marks a tool human-only only when its bound route carries
`ServicePrincipalForbiddenGuard`/`HumanOnlyGuard` (`boot-validation.ts:249-251`). `UsersController.create`
has neither, so `user_create` (PR #1343, class `elevated`, input accepts `role`) will be registered as
callable by a service principal on every channel. §6.6 assumes "the ungrantable set already denies it
… `user:manage`", but that is only true for grants written after SEC-011.

## Impact

A holder of a legacy SA token with `user:manage` can mint or promote an **ADMIN** (ADMIN-equivalent
escalation, which violates INV-SA-3) and can reset or provision that account's credential. A legacy
`settings:manage` grant can re-scope any KB folder's ACL (widening access to restricted articles). The
SA-performed writes are audited with `actorId = null` (issue #141), so the escalation is also poorly
attributed.

After #1343, if an admin grants `ai:use` to such an SA (the AI access setting defaults to read-write),
indirect prompt injection in content the run reads can drive `user_create {role: ADMIN}` with no human
in the loop (T-34).

**Why Medium and not High.** It needs a specific precondition: an SA that was granted an ungrantable
verb **before 2026-06-12** and was never re-saved (a PATCH of the grant set runs `cleanPermissions`,
which drops the verb). The token is an admin-issued credential. On an instance where the data check
below finds a hit, the impact is ADMIN takeover, and the practical severity is **High**. Re-rate after
#1343 merges.

## Proof of concept

Reasoned from the code, **not executed**.

```sh
# Precondition: SA "ci-bot" created before 2026-06-12 with permissions [..., "user:manage"]
#   (service_account_permissions row present; never re-saved since).
curl -X POST https://lazyit.example/api/users \
  -H "Authorization: Bearer lzit_sa_<id>_<secret>" -H "Content-Type: application/json" \
  -d '{"email":"eve@example.com","firstName":"Eve","lastName":"X","role":"ADMIN"}'
# -> 201: RolesGuard service branch finds "user:manage" in principal.permissions;
#    no ServicePrincipalForbiddenGuard on UsersController.
# Then POST /users/<new-id>/provision-local-account (or reset-password), also user:manage, gives a credential.
#
# Headless variant (after #1343): the same SA also holds ai:use, and AI access is read-write (default).
#   invoke('user_create', {email, firstName, lastName, role: 'ADMIN'}, {channel: 'HEADLESS'})
#   -> invokeWrite runs it: no ceiling, no approval, no step-up.
```

## Affected

At `origin/dev` 84bd521d.

- `apps/api/src/service-accounts/service-account-permissions.ts:16-26`: catalog filter only, no
  ungrantable strip.
- `apps/api/src/auth/principal-loader.service.ts:121-131`: `serviceAccountPrincipal` builds the SA
  permission set from those rows.
- `apps/api/src/auth/roles.guard.ts:82-90`: the service branch authorizes on the held set alone.
- `apps/api/src/users/users.controller.ts:92` (class, no Layer-2 guard), `:403-412` (`POST /users`),
  `:440-461` (`PATCH /users/:id`), `:463`, `:568`, `:597`, `:624`, `:645`, `:671`: `user:manage` routes.
- `apps/api/src/article-categories/article-categories.controller.ts:144-158` and
  `apps/api/src/instance/update.controller.ts:64-72`: `settings:manage` routes with no Layer-2 guard.
- `apps/api/src/common/actor.service.ts:34-36`: `resolve` gives `undefined` for an SA, which skips the
  self-role guard at `users.service.ts:982`.
- `apps/api/src/ai/core/ai-tool.service.ts:74-79`, `:159-199` and `apps/api/src/ai/core/boot-validation.ts:249-251`:
  headless has no ceiling by default, and a route without a human-only guard is SA-callable.
- `packages/shared/src/schemas/service-account.ts:59-65`: the ungrantable set (the source of truth to
  reuse).
- PR #1343 (`feat/issue-1315-ai-users-tools`), `apps/api/src/ai/tools/users.tools.ts` `user_create`:
  the headless vector (not yet on `dev`).

## Recommendation

1. **Strip at principal load (read-time, DB-first, INV-1).** In `resolveServiceAccountPermissions`,
   drop every literal in `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS` as well as catalog-foreign ones:

   ```ts
   const UNGRANTABLE: ReadonlySet<string> = new Set(SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS);
   if (ALL_PERMISSIONS.has(p as Permission) && !UNGRANTABLE.has(p)) resolved.add(p as Permission);
   ```

   This neutralises every legacy row on **every** route and channel at once (HTTP, MCP, headless),
   without depending on each controller remembering a guard. Layer 2 stays as defense in depth.
2. **Surface existing grants (upgrade-safe, no destructive migration).** Do not delete rows in a
   migration. The read-time strip makes them inert, and the audit trail stays intact. Add a data check
   an operator or admin can see, for example log a warning at boot (or show a badge on the SA detail)
   for any SA holding an ungrantable verb. When an admin next saves the grant set, `cleanPermissions`
   removes the row through the normal audited `PERMISSION_CHANGE` path. Check query:

   ```sql
   SELECT sa.id, sa.name, p.permission
   FROM service_account_permissions p JOIN service_accounts sa ON sa.id = p."serviceAccountId"
   WHERE p.permission IN ('settings:manage','user:manage','import:run','secret:read','secret:manage');
   ```

3. Make the SA read shape (`sortedCatalog` in `service-accounts.service.ts:405-411`) either hide or flag
   the stripped verbs, so the UI does not show a power the account no longer has.
4. Before #1343 merges, have [[ai-assistant/security|AI security]] §6.6 state that the INV-SA-3
   assumption depends on (1).

## Prevention

- Enforce a "never holds" invariant where the principal is **built**, not per route. A guard-per-route
  backstop silently misses every new route that reuses a meta verb.
- Add a unit test: `resolveServiceAccountPermissions([{permission:'user:manage'}, {permission:'asset:read'}])`
  returns only `asset:read`. Add a parity test asserting the resolver excludes every member of
  `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS`.
- An AI-core boot check that refuses to register an `elevated` tool reachable by a service principal
  unless the route's permission is SA-grantable.

## References

- CWE-269 (Improper Privilege Management).
- [[INVARIANTS]] INV-1, INV-SA-2, INV-SA-3 · [[SEC-011-service-account-coarse-meta-permission-escalation|SEC-011]]
  (Layer 1/2) · [[0048-service-accounts]] · [[ai-assistant/security|AI security]] §6.2, §6.6, T-34 ·
  epic #1315, PR #1343 · issue #141 (SA actor audit column).

## Resolution

**Status**: fixed
**Fixed in**: commit `d4fb99d9` (`fix(api): strip SA-ungrantable permissions at principal load (SEC-073, #1315)`)
and commit `30f6e34e` (`fix(api): hide inert SA-ungrantable grants in the service account read shape (SEC-073, #1315)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-09-24

The root fix is recommendation (1): the ungrantable set is stripped where the service principal is
**built**, so it no longer depends on each controller carrying a Layer-2 guard. Every service-principal
path goes through `PrincipalLoaderService.serviceAccountPrincipal` (the `JwtAuthGuard` SA-token branch,
the delegated-identity branch, and the AI core's `loadPrincipal` for MCP and headless runs), so one
change covers HTTP, MCP and headless. Resolution stays DB-first on every request (INV-1); nothing is
cached.

### Changes
- `apps/api/src/service-accounts/service-account-permissions.ts`: `resolveServiceAccountPermissions`
  drops every `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS` literal (imported from `@lazyit/shared`, the
  single source of truth) as well as catalog-foreign ones. New `ungrantableServiceAccountGrants` helper.
- `apps/api/src/auth/principal-loader.service.ts`: logs a warning once per account per process when an
  SA carries inert ungrantable grants (account id, name and the verbs; no secret). Recommendation (2).
- `apps/api/src/service-accounts/service-accounts.service.ts`: the wire shape uses `cleanPermissions`,
  so the SA detail no longer shows a verb the account does not hold. Saving the set the UI shows removes
  the legacy row through the audited `PERMISSION_CHANGE` path. Recommendation (3).
- `packages/shared/src/schemas/service-account.ts`: doc comment only (the backstop wording).
- Docs: [[INVARIANTS]] INV-SA-3 (Layer 0), [[0048-service-accounts]] (principal-load strip),
  `docs/02-domain/entities/service-account-permission.md`, [[ai-assistant/security|AI security]] §6.6
  (recommendation 4).

### Tests added
- `apps/api/src/service-accounts/service-account-permissions.spec.ts`::"strips a legacy SA-ungrantable
  grant (user:manage) and keeps the grantable ones" and "never resolves ANY member of
  SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS (parity with the shared list)": fail without the fix because
  the resolver kept every catalog literal.
- `apps/api/src/users/users.sa-ungrantable.authz.spec.ts` (real `JwtAuthGuard` + `RolesGuard` over the
  real `UsersController`, SA token with a legacy `user:manage` row): `POST /users` with `role: ADMIN`
  and `PATCH /users/:id` with `role: ADMIN` both return 403 and never reach the service. Without the fix
  they returned 201 / 200. A control test proves the token authenticates and `user:read` still works.
- `apps/api/src/ai/core/ai-tool.write-path.spec.ts`::"refuses a headless user:manage write by an SA
  holding only a legacy (pre-SEC-011) grant (SEC-073)": a headless `invoke` of an elevated fixture tool
  bound to a `user:manage` route returns FORBIDDEN 403 and executes nothing; the same SA still runs a
  grantable write. Fails without the fix (the route executed). The `user_create` tool itself is in
  PR #1343, not yet on `dev`, so the vector is covered at the permission-resolution level and through
  the real dispatcher and guard chain.
- `apps/api/src/service-accounts/service-accounts.service.spec.ts`::"hides the inert verb on read and
  drops the row on the next permission save": the read shape omits the legacy row and saving it back
  removes the row with a `PERMISSION_CHANGE { removed: ['user:manage'] }` audit entry.

### Verification
Charter validation block: shared / api / web / agent `tsc --noEmit` clean; api Jest 218 suites,
3837 tests passed; `packages/shared` and `apps/web` `bun test` 0 fail; `apps/agent` has 2 pre-existing
failures that need `pwsh` (unrelated to this change). Changed-file eslint in `apps/api` clean.

### Residual risk
- **Existing data**: legacy rows stay in `service_account_permissions` until an admin re-saves that
  account's grants (no destructive migration, audit trail intact). They confer nothing in the meantime.
  The operator sees a warning in the API log.
- **Follow-up (defense in depth, not needed for the fix)**: add `ServicePrincipalForbiddenGuard` to the
  `user:manage` routes of `UsersController`, `PUT /article-categories/:id/access-rules` and
  `PUT /instance/update-settings`, so AI boot validation marks those tools human-only; and the
  Prevention item for an AI-core boot check refusing an `elevated` tool whose route permission is
  SA-ungrantable.
- The SA-actor audit gap (issue #141) is unchanged.
