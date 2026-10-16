---
id: SEC-088
title: A non-ADMIN role delegated user:manage or settings:manage can make itself ADMIN (no subset rule, matrix self-edit)
severity: medium
status: fixed
cwe: CWE-269
discovered: 2026-10-09
module: users / config (RBAC delegation)
tags: [authz, privilege-escalation, rbac, delegation, admin-takeover]
---

# SEC-088 — Delegated `user:manage` or `settings:manage` escalates a MEMBER/VIEWER role to ADMIN

## Summary

When an ADMIN grants `user:manage` or `settings:manage` to MEMBER or VIEWER through the permission
matrix, any holder of that role can mint an ADMIN, or take over an existing one, and so control the
whole instance. Nothing limits a user administrator to roles at or below their own, and nothing stops a
matrix editor from widening their own role.

## Description

ADR-0046 accepts delegating the coarse verbs to MEMBER or VIEWER as a feature: "granting MEMBER a
`:delete` or a coarse verb is the intended feature — the only guardrails are ADMIN-immutable +
catalog-membership" (`docs/03-decisions/0046-roles-permissions-v2.md:266-268`, `:272-275`;
`docs/02-domain/entities/role-permission.md:42-46`). The ADR and the UI present this as granting an
admin-level capability. In practice, each of these two verbs gives the holder ADMIN itself, because the
code has no ceiling on what the holder can do with it:

1. **`user:manage` has no subset rule.** Every user-administration route checks only the verb
   (`apps/api/src/users/users.controller.ts:467-468`, `:478-479`, `:504-505`, `:525-526`, `:615-616`,
   `:644-645`, `:671-672`, `:692-693`). The service then accepts any target role and any target user:
   - `create` takes `data.role` from the payload, ADMIN included (`users.service.ts:580`). In local mode
     the same call can set the new account's password (`:621-629`), so the caller can sign in as the new
     ADMIN straight away.
   - `update` refuses only a change to the caller's own role (`users.service.ts:799-806`) and the
     demotion or deactivation of the *last* active ADMIN (`:808-820`). Promoting someone else to ADMIN,
     or demoting and deactivating every other ADMIN, passes. Changing an ADMIN's email passes too.
   - `clone` is `create` with extras (`users.service.ts:1461-1475`; `CloneUserSchema.profile` is a full
     `CreateUserSchema`, `packages/shared/src/schemas/clone-user.ts:28`), so it mints an ADMIN the same way.
   - `requestPasswordReset` in local mode returns a temporary password for any active, non-directory
     user, ADMIN included (`users.service.ts:999-1062`). This takes over a named ADMIN account.
   - `remove` / `offboard` and `restore` check only the last-admin guard (`users.service.ts:1262-1264`)
     or nothing at all (`:1400`). A non-ADMIN can offboard ADMINs, or bring an offboarded ADMIN back with
     full powers.
   - The AI and MCP tools reach the same handlers. `user_create`, `user_update` and `user_restore` call
     the route as the principal (`apps/api/src/ai/tools/users.tools.ts:43-55`, `:574-640`), so the gate
     and the missing ceiling are the same. The `elevated` step-up asks for the attacker's own password,
     which they have.

   The self-role guard was designed for the ADMIN-on-ADMIN case ("Privilege changes must be made BY one
   admin ON another", `users.service.ts:800-802`). It does not act as a ceiling: a MEMBER who cannot
   change their own role creates a second account as ADMIN and uses it to promote the first.

2. **`settings:manage` edits the matrix that grants it.** `PUT /config/permissions` is gated only by
   `settings:manage` plus the service-account refusal (`apps/api/src/config/config.controller.ts:155-173`).
   The strict body takes the MEMBER and VIEWER sets (`packages/shared/src/schemas/permission.ts:455-460`),
   and the service never compares them with the caller's role (`apps/api/src/config/permissions-config.service.ts`).
   A MEMBER holding `settings:manage` can therefore add `user:manage` (or anything else in the catalog)
   to MEMBER, which is their own role, and then follow path 1. The code comment that rules this out is
   true only for the shipped defaults: "only an ADMIN (settings:manage) can edit the matrix … so an admin
   can never widen *themselves*" (`permissions-config.service.ts:166-169`).
   The same verb also gates the whole service-accounts API (`apps/api/src/service-accounts/service-accounts.controller.ts:76-81`).
   The delegate can therefore mint SA tokens with every SA-grantable verb, and those tokens keep working
   after the delegation is withdrawn. They stay below ADMIN (SEC-011 / INV-SA-3), but they are a
   persistence foothold.

ADR-0048 already reached this conclusion for service accounts: either verb "makes a bot
ADMIN-equivalent" (`docs/03-decisions/0048-service-accounts.md:92-98`), which is why both are
SA-ungrantable (SEC-011). The human side was never re-examined. For a human role the same verbs remain
fully delegable with no ceiling.

**Default exposure.** None. With the shipped `DEFAULT_ROLE_PERMISSIONS`
(`packages/shared/src/schemas/permission.ts:384-420`), neither MEMBER nor VIEWER holds `user:manage`,
`settings:manage` or `accessGrant:grant` (checked by evaluating the constant: all `false`). No migration
grants them, and the seed is seed-once, so it never widens an existing instance. The finding needs an
ADMIN to have deliberately granted one of the two verbs to MEMBER or VIEWER.

**Mitigations in place, and their limits.**
- Both verbs are `tier: "coarse"` (`packages/shared/src/schemas/permission-meta.ts:282-286`, `:296-300`).
  The matrix UI marks them ⚠ Admin-level and sends the save through a consequence confirmation.
- The `userManage` consequence is honest: "change roles (including granting ADMIN)"
  (`apps/web/messages/en/settings.json:627`). The `settingsManage` consequence is not: it says "configure
  the instance and manage taxonomies" (`:628`). It does not say that the holder can rewrite roles'
  permissions, including their own, and from there reach ADMIN. Nothing in the UI says that either verb
  is equivalent to making every holder an ADMIN.
- A matrix widening to a high-risk verb emits one `permission_widened` nudge to the admin feed
  (`permissions-config.service.ts:24-30`, `:170-172`) and writes `PermissionAuditLog` rows. These are
  detective controls, not preventive ones. Creating or promoting an ADMIN emits no notification; it
  leaves only a `UserHistory` `CREATED` / `ROLE_CHANGED` row.

**Invariants.** This contradicts the [[INVARIANTS]] INV-8 enforcement note. That note describes
`GET`/`PUT /config/permissions` as "ADMIN-only" (`INVARIANTS.md:266-268`) and the permission-parity
golden test as proving the matrix routes resolve to ADMIN-only (`:261-265`). Both are true only against
the seed: the golden test resolves against `DEFAULT_ROLE_PERMISSIONS`, not against a widened matrix. No
invariant states the human equivalent of INV-SA-3 ("never ADMIN-equivalent"). This finding is that gap.

## Impact

Any human whose role an ADMIN has granted `user:manage` or `settings:manage` can gain full instance
control. This works over the web session (OIDC or local), and through the AI tools that call the same
routes, under their usual approval and step-up. With that control they can:
- read every ADMIN-only surface (activity logs, the workflow engine, notifications, service accounts);
- grant themselves or anyone application access;
- create durable service-account tokens;
- demote and offboard the legitimate ADMINs. The last-admin guard keeps one active ADMIN, and that ADMIN
  can be the attacker's.

INV-10 still holds: zero-knowledge vault values stay unreadable without a crypto membership.

Risk rises with #1560. Custom roles exist to delegate slices of administration ("Help desk = MEMBER +
`accessGrant:grant`"), so granting `user:manage` to a non-ADMIN role becomes the expected configuration,
not the exception.

## Proof of concept

Reasoned from the code, **not executed** (the API is not run during review). `$TOKEN` is a MEMBER whose
role an ADMIN granted `user:manage`:

```sh
# Local mode: mint an ADMIN with a known password, then sign in as it.
curl -X POST https://lazyit.example/api/users -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"m2@corp.example","firstName":"M","lastName":"Two","role":"ADMIN","password":"Tmp-Passw0rd-123!"}'

# OIDC mode: same create without "password", using an address the attacker can verify at the IdP.
# The first sign-in links the row by verified email (INV-2). Or promote an existing account:
curl -X PATCH https://lazyit.example/api/users/<accomplice-id> -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"role":"ADMIN"}'

# Local mode, takeover of a named ADMIN: returns { temporaryPassword } for that ADMIN.
curl -X POST https://lazyit.example/api/users/<admin-id>/reset-password -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"delivery":"temporary-password"}'
```

With `settings:manage` instead (MEMBER holder):

```sh
curl https://lazyit.example/api/config/permissions -H "Authorization: Bearer $TOKEN"   # current matrix
# PUT the same MEMBER and VIEWER sets, with "user:manage" added to MEMBER:
curl -X PUT https://lazyit.example/api/config/permissions -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"MEMBER":[…,"user:manage"],"VIEWER":[…]}'
# The resolver cache is invalidated on commit; the next request holds user:manage → the calls above.
```

## Affected

At commit `36f355450` (`feat/issue-1543-remove-bundled-zitadel`; the same code is on `dev`).

- `apps/api/src/users/users.controller.ts:467-523` — create, clone and update gated by `user:manage` alone.
- `apps/api/src/users/users.controller.ts:525-718` — reset-password, delete, offboard, restore and
  provision-local-account, also `user:manage` alone.
- `apps/api/src/users/users.service.ts:580` — the target role is taken from the payload, ADMIN included.
- `apps/api/src/users/users.service.ts:799-820` — `update` guards only self-role and last-admin.
- `apps/api/src/users/users.service.ts:999-1062` — the local-mode temporary password for any active user.
- `apps/api/src/users/users.service.ts:1253-1264`, `:1400` — offboard (last-admin only) and restore (no
  target check).
- `apps/api/src/users/users.service.ts:1461-1475` — clone mints the user through `create`.
- `apps/api/src/ai/tools/users.tools.ts:574-640` — `user_create` (and `user_update`, `user_restore`)
  reach the same routes.
- `apps/api/src/config/config.controller.ts:155-173` — `PUT /config/permissions` gated by
  `settings:manage` alone.
- `apps/api/src/config/permissions-config.service.ts:164-169` — the comment that assumes only an ADMIN
  can edit the matrix.
- `apps/web/messages/en/settings.json:628` — the `settingsManage` consequence omits matrix self-edit.

## Recommendation

Do not close this by making the verbs undelegable. Delegation is the point of ADR-0046 P5 and of #1560.
Bound it instead. This changes ADR-0046 P5/P7 ("an admin-initiated delegation is accepted"), so it needs
an ADR amendment or the #1560 ADR. It can ship standalone ahead of #1560, or as part of its U2 unit
(the proposed INV-ROLE-1).

1. **A subset rule on every `user:manage` write.** An actor may create, update, clone, offboard, restore,
   reset the password of, provision, or change the email of a user only when:
   - the permissions of the target's current role are a subset of the actor's own; and
   - for a role change or a create, the permissions of the target's new role are a subset of the actor's
     own.

   ADMIN is the full catalog, so only an ADMIN can then assign, remove, demote, offboard, restore or
   reset an ADMIN. Keep the existing rule that nobody changes their own role. Enforce it once, in
   `UsersService`, so the AI and MCP tools inherit it. On a violation, return 403.
2. **An ADMIN-only `role:manage` for the matrix (and, later, role CRUD).** Move `GET`/`PUT
   /config/permissions` from `settings:manage` to `role:manage`. Make `role:manage` refused in the
   MEMBER/VIEWER sets by `UpdateRolePermissionsSchema` and SA-ungrantable, as the analysis on #1560
   proposes. A stopgap until then: the PUT refuses an actor whose DB role is not ADMIN.
3. **Clone copies authority.** `cloneAccessGrants` and `cloneAssetAssignments` mirror grants and
   assignments under `user:manage` alone, without the actor holding `accessGrant:grant` or
   `asset:write` (the verbs of the grant and assignment routes). Under the subset rule, also require the verbs the mirrored rows need.
4. **UI copy.** Until item 2 lands, the `settingsManage` consequence (en + es) should say that the holder
   can change what every non-ADMIN role may do, their own role included.

Upgrade-safety of the fix: there is no data change. An instance that delegated these verbs keeps the
rows, and the holders keep the slice at or below their own role. They lose only the ability to reach
ADMIN, which is the intended behaviour.

## Prevention

- Add the human counterpart of INV-SA-3 to [[INVARIANTS]] when the fix lands (the proposed INV-ROLE-1):
  no non-ADMIN principal can create, promote to, or act on an ADMIN, and no principal can widen its own
  role.
- Extend the permission-parity golden test with a widened matrix (MEMBER holding `user:manage`, then
  `settings:manage`). It must assert that every ADMIN-target write and every matrix write still returns
  403 for MEMBER. Today the test resolves only against the seed, so it cannot catch a delegation path.

## References

- CWE-269 Improper Privilege Management; OWASP A01:2021 Broken Access Control.
- [[0046-roles-permissions-v2]] (P5, P7 — the accepted delegation) · [[0048-service-accounts]] (Fork #3,
  the SA ungrantable ceiling) · [[role-permission]] · [[0058-user-manager-and-clone-actions]].
- [[SEC-011-service-account-coarse-meta-permission-escalation|SEC-011]] — the same verbs found
  ADMIN-equivalent for service accounts.
- Issue #1560 (custom roles) and its analysis comment, which proposed `role:manage` and the subset rule.

## Triage note (2026-10-15, after the 2026-10-10 audit remediation)

Still open: AUD-002 is a **pending CEO decision** (the subset rule for `user:manage`). PR #1571 changed
`users.service.ts` (history in the same transaction, the last-admin guard under the `lazyit.admin_set`
lock, AUD-019/041) but not who may assign or act on which role. The escalation paths described above are
unchanged.

## Triage note (2026-10-16, after the audit decision round)

Still open at **Medium**. Most of the escalation paths above are closed, by CEO decisions of 2026-10-15
and 2026-10-16. Two `settings:manage` paths remain, and each needs a CEO decision.

**Fixed** (re-checked on `dev` at `cab67672f`):
- **Role ceiling on `user:manage`** (recommendation 1, PR #1601 `18a04017b`).
  - Every Users write refuses with 403 `ROLE_CEILING_EXCEEDED` when the role it grants, or the role of the
    user it acts on, ranks above the caller's (`ADMIN > MEMBER > VIEWER`). This covers create, clone, a
    role change, any update, reset, provisioning, offboard and restore.
  - The rule is `assertCeiling` (`apps/api/src/users/users.service.ts:184-194`), built on `canManageRole`
    from `@lazyit/shared`.
  - The target's role is re-read `FOR UPDATE` inside the write transaction, so a concurrent promotion
    cannot slip between the check and the write.
  - A service-account actor is capped below ADMIN, and a call with no actor fails closed at VIEWER.
  - The AI and MCP tools inherit the rule.
  - AUD-040 landed in the same PR: the last-admin guard counts only admins who can sign in.
- **The permission matrix and the directory connection are ADMIN-only** (recommendation 2, as the stopgap
  it describes; PR #1606 `9bc75c4f5`).
  - `PUT /config/permissions`, `PUT /directory/connection` and `POST /directory/sync` carry
    `AdminOnlyGuard` next to `settings:manage`. The guard returns 403 `ADMIN_REQUIRED` to anyone who is not
    a human ADMIN.
  - Locations: `apps/api/src/config/config.controller.ts:156-158` and
    `apps/api/src/directory/directory.controller.ts:66-68`, `:93-95`.
  - The reads stay on `settings:manage`. The ADMIN-only rule lasts until custom roles (#1560) bring a
    `role:manage`.
- **Clone copies only what the caller could grant by hand** (recommendation 3, PR #1606).
  - Assignments need `asset:write` and access grants need `accessGrant:grant`.
  - A row the caller cannot copy is reported in `skipped` with reason `permission_required`
    (`users.service.ts:1646` onward).
- **A promotion revokes one-time credentials** (PR #1606).
  - When `PATCH /users/:id` raises the role, judged against the locked row (`users.service.ts:937-944`),
    the same transaction does three things: it clears a temporary password not yet replaced
    (`mustChangePassword` with a hash), bumps the session and MCP epochs, and marks every live
    `PasswordResetToken` used (`revokeOneTimeCredentials`, `:1310-1329`). `ROLE_CHANGED` records
    `credentialsRevoked: true`.
  - The admin reset-link mint re-runs the locked ceiling check inside its own transaction, so a mint
    cannot race a promotion.
- **UI copy** (recommendation 4, PR #1609 `cab67672f`).
  - The `settingsManage` consequence now says that the matrix and the directory connection stay
    admin-only (`apps/web/messages/en/settings.json:629`, and `es`).
  - The `userManage` copy no longer claims the holder can grant ADMIN.
  - The matrix and the directory form render read-only for non-admins.

**Remaining, pending a CEO decision:**
1. **`PUT /smtp` is `settings:manage`-only** (`apps/api/src/smtp/smtp.controller.ts:59-61`).
   - A delegate can repoint outbound mail at a server they control.
   - They then trigger the public `POST /auth/forgot-password` for an ADMIN
     (`apps/api/src/auth/local/password-lifecycle.controller.ts:118`).
   - The reset link travels through their server, and they take over the ADMIN account. This applies in
     local mode.
   - Fix direction: the same `AdminOnlyGuard` on the SMTP write.
2. **Service-account token minting exceeds the delegate's own role.**
   - Every service-accounts route is `settings:manage`-only
     (`apps/api/src/service-accounts/service-accounts.controller.ts:80-158`).
   - The service does not compare the SA's verbs with the caller's role, so a MEMBER delegate can mint
     a token holding SA-grantable verbs MEMBER lacks.
   - These tokens stay below ADMIN (SEC-011, INV-SA-3) and outlive the delegation.
   - Fix direction: cap the SA verbs at the caller's own set, or make the route ADMIN-only.

**Known limit (accepted with the promotion fix).** A promotion cannot revoke a temporary password that the
user has already replaced. Once replaced, it is the user's own password, and lazyit does not record who
issued the original. A delegate who reset a user and then watched them sign in does not learn the new
password, so this does not reopen the path.

No data change on update. An instance that delegated these verbs keeps its rows. The holders lose only
what is listed under Fixed.

## Resolution

**Status**: fixed
**Fixed in**: the role ceiling on `user:manage` in PR #1601 (`18a04017b`); the matrix and directory writes
ADMIN-only, clone limited to what the caller could grant, and promotion revoking one-time credentials in PR
#1606 (`9bc75c4f5`); the UI copy in PR #1609 (`cab67672f`); the two remaining `settings:manage` paths in
PR #1611: `5310b682a` (`fix(api): saving the SMTP settings is ADMIN-only (SEC-088)`) and `584bd45f0`
(`fix(api): cap service-account verbs at the caller's own permissions (SEC-088)`), with `846acf864`
(ADR-0079, ADR-0048 and ADR-0046 amendments, INV-SA-3)
**Fixed by**: 2026-10-10 audit decision round (CEO decisions of 2026-10-15 and 2026-10-16; the last two
paths by CEO decision of 2026-10-16)
**Date**: 2026-10-16

### Evidence (on `fix/sec-088-smtp-and-sa-ceiling`, PR #1611)
- `apps/api/src/smtp/smtp.controller.ts:63`: `PUT /config/smtp` carries `AdminOnlyGuard` next to
  `settings:manage`, so a delegate gets 403 `ADMIN_REQUIRED` and cannot repoint outbound mail to read an
  ADMIN's reset link. `GET` and `POST /config/smtp/test` stay on `settings:manage`: the read returns no
  secret, and the test send persists nothing and uses the relay an ADMIN saved.
- `apps/api/src/service-accounts/service-accounts.service.ts:356-378` (`assertWithinCallerPermissions`):
  the caller's verbs resolve DB-first from their role. A verb outside that set is refused with 403
  `PERMISSION_CEILING_EXCEEDED`, listing the verbs. Call sites:
  - create (`:88`);
  - update (`:192`): the verbs it adds, or the whole set when it re-enables the account or extends its
    expiry;
  - rotate (`:266`);
  - restore (`:334`).
  Narrowing writes are not checked, so a delegate can always disable or revoke an account. ADMIN holds the
  full catalog.
- The paths fixed earlier are listed in the 2026-10-16 triage note above.

### Tests
- `apps/api/src/smtp/smtp.controller.spec.ts`: a delegated MEMBER is refused `PUT` with `ADMIN_REQUIRED`
  and nothing is saved, a service account is refused, an ADMIN saves, and the read and test send stay
  available to the delegate.
- `apps/api/src/service-accounts/service-accounts.service.spec.ts`, block `permission ceiling — a delegate
  cannot exceed its own verbs (SEC-088)`: create, an added verb, re-enable, clearing or extending the
  expiry, rotate and restore are refused past the ceiling with nothing written. An unattributed caller
  fails closed. Narrowing writes pass, and ADMIN is unaffected.
- The earlier paths' tests are listed in PRs #1601 and #1606.

### Verification
Re-run on the PR branch on 2026-10-16: `node node_modules/.bin/jest` over all of `apps/api`. 314 suites
and 7325 tests passed. Without the fixes, the new denial tests fail: 1 in the SMTP suite and 6 in the
service-account suite.

### Residual risk
- `settings:manage` stays delegable for the rest of instance configuration. The surfaces that decide who
  can do what are ADMIN-only until custom roles (#1560) bring a `role:manage`: the matrix, the directory
  connection and the SMTP save.
- A service account minted before this change, with verbs above its creator's role, keeps working. The
  cap applies on the next write that would issue or re-arm its token. An ADMIN who wants it gone revokes
  or narrows it.
- The accepted limit from the promotion fix stands: a temporary password the user already replaced
  cannot be revoked by a promotion.
- No data change.
