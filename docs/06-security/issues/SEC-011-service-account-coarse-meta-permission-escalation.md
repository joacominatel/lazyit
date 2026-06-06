---
id: SEC-011
title: A service account can be granted coarse meta-permissions (settings:manage / user:manage) → ADMIN-equivalent self-escalation
severity: medium
status: open
cwe: CWE-269
discovered: 2026-06-06
module: service-accounts / auth (authz)
tags: [privilege-escalation, authz, service-accounts, rbac, persistence]
---

# SEC-011 — Service accounts can hold coarse admin meta-permissions and self-escalate to ADMIN-equivalent

## Summary

Nothing prevents a service account from being granted the coarse "meta" permissions
`settings:manage` or `user:manage`. Either one makes the bot effectively ADMIN-equivalent — and
`settings:manage` lets it SELF-escalate to the full catalog and mint backdoor service accounts — which
contradicts INV-SA-3 ("a service account is NEVER ADMIN-equivalent").

## Description

A service account is authorized purely by the catalog literals in its `ServiceAccountPermission` grant
set (`roles.guard.ts:82-97`, resolved DB-first). The grant set can contain ANY literal in the frozen
`@lazyit/shared` catalog — `ServiceAccountPermissionsSchema` only checks catalog-membership + `.min(1)`
(`packages/shared/src/schemas/service-account.ts:42-45`); there is no notion of a permission that is
"ungrantable to a non-human". So a service account may hold the two coarse capability verbs that gate
the privilege-management surfaces:

- **`settings:manage`** gates the ENTIRE Service-Accounts management API
  (`service-accounts.controller.ts:59-176` — every route) AND `PUT /config/permissions`
  (`config.controller.ts:147-164`). A bot holding it can therefore:
  1. **Self-escalate**: `PATCH /service-accounts/:id` (its own id) REPLACES the grant set wholesale
     with any catalog permissions (`service-accounts.service.ts:135-207`, no self/escalation guard) —
     it can grant itself `user:manage`, `accessGrant:grant` and every `:delete`, i.e. the complete
     catalog.
  2. **Persist**: `POST /service-accounts` mints NEW service accounts with arbitrary grants (incl.
     `settings:manage`), so revoking the original token does not remove the foothold.
  3. **Rewrite HUMAN authz**: `PUT /config/permissions` replaces the MEMBER + VIEWER permission sets,
     so the bot can grant every human MEMBER/VIEWER any capability (e.g. give VIEWER `user:manage`).
- **`user:manage`** gates `POST /users`, which "can set the RBAC role" (`users.controller.ts:231-234`):
  a bot holding it can create a fresh **human ADMIN** account.

The permission model (ADR-0046) made the fine-grained permission the unit of authorization; holding the
complete catalog is exactly what makes a human ADMIN omnipotent. A service account that can reach the
complete catalog (directly, or transitively via `settings:manage`) is therefore ADMIN-equivalent in
capability — the one thing INV-SA-3 / ADR-0048 Fork #3 say must never happen. The only thing it cannot
do is edit the immutable ADMIN row or carry `Role.ADMIN`, neither of which it needs.

Compounding the audit story: an SA managing service accounts / the permission matrix is attributed with
`actorId = null` (`service-accounts.controller.ts:42-44`, `config.controller.ts:163` via
`@CurrentUser()` which is undefined for an SA), because `ServiceAccountAuditLog` has no SA-actor column
(acknowledged gap, issue #141). So a self-escalating bot's management actions are logged as
system/unknown, not attributable to the bot.

This is a divergence (not accepted debt): ADR-0048 states "never the `Role` enum, never ADMIN" and
INV-SA-3 codifies "never ADMIN-equivalent", but the catalog/schema/guards impose no ceiling on which
permissions a service account may hold or grant.

## Impact

A service account that an operator grants `settings:manage` (the natural grant for "let this bot manage
instance settings / other bots") is, from that moment, a hidden administrator: it can grant itself the
full capability set, create self-perpetuating backdoor service accounts, and rewrite the human
MEMBER/VIEWER authorization matrix — all while its management actions are audited as `null`. A leaked
SA token with `settings:manage` (or `user:manage`) is thus a full-control + persistence primitive, not
the least-privilege credential the model promises.

Mitigating context: it requires an ADMIN to first grant the coarse verb to the service account (it is
never seeded). Rated **Medium** for that precondition; the intrinsic escalation once granted is severe
and could be argued High in any deployment that uses `settings:manage`/`user:manage` service accounts.

## Proof of concept

Reasoned, **not executed** (the API is not run during review). Given an SA token
`lzit_sa_<id>_<secret>` whose account holds only `settings:manage`:

```sh
# 1) self-escalate to the full catalog (replace own grant set)
curl -X PATCH http://localhost:3001/service-accounts/<id> \
  -H "Authorization: Bearer lzit_sa_<id>_<secret>" \
  -H 'content-type: application/json' \
  -d '{"permissions":["user:manage","accessGrant:grant","asset:delete","article:delete",
       "user:delete","application:delete","consumable:delete","location:delete",
       "assetModel:delete","category:delete","accessGrant:delete","settings:manage",
       "asset:read","asset:write", "...the rest of the catalog..."]}'

# 2) persist: mint a second, independent admin-equivalent bot
curl -X POST http://localhost:3001/service-accounts \
  -H "Authorization: Bearer lzit_sa_<id>_<secret>" \
  -H 'content-type: application/json' \
  -d '{"name":"ci","permissions":["settings:manage","user:manage"]}'   # token returned once

# 3) rewrite human authz: give every VIEWER user:manage
curl -X PUT http://localhost:3001/config/permissions \
  -H "Authorization: Bearer lzit_sa_<id>_<secret>" \
  -H 'content-type: application/json' \
  -d '{"MEMBER":[...],"VIEWER":["user:manage", "..."]}'
```

All three pass the `RolesGuard` service branch (the SA "fully holds" `settings:manage`), and the audit
rows for (2)/(3) record `actorId = null`.

## Affected

- `packages/shared/src/schemas/service-account.ts:42-45` — `ServiceAccountPermissionsSchema` accepts
  any catalog literal; no ceiling excludes the coarse meta verbs.
- `apps/api/src/service-accounts/service-accounts.controller.ts:59-176` — every management route gated
  only on `settings:manage`; a service principal holding it passes.
- `apps/api/src/service-accounts/service-accounts.service.ts:135-207` — `update` replaces the grant set
  wholesale with no self-escalation / no-meta guard.
- `apps/api/src/config/config.controller.ts:147-164` — `PUT /config/permissions` gated only on
  `settings:manage`, reachable by a service principal (edits HUMAN MEMBER/VIEWER authz).
- `apps/api/src/users/users.controller.ts:231-234` — `POST /users` (`user:manage`) can set role ADMIN.
- `apps/api/src/auth/roles.guard.ts:82-97` — service branch authorizes purely on the held grant Set;
  there is no concept of a permission a service account may never hold.
- Premise: `docs/06-security/INVARIANTS.md` INV-SA-3 / INV-SA-2, ADR-0048 Fork #3.

## Recommendation

Impose a ceiling so a service account can never reach ADMIN-equivalent capability:

- Define an **SA-ungrantable** subset of the catalog in `@lazyit/shared` (at minimum the principal- and
  authz-management verbs: `settings:manage`, `user:manage`; strongly consider `accessGrant:grant` and
  the `:delete` family). Reject any of them in `CreateServiceAccountSchema` / `UpdateServiceAccountSchema`
  (400) and re-filter defensively in `ServiceAccountsService.cleanPermissions`.
- AND/OR refuse a **service principal** outright on the management surfaces regardless of its grants: in
  the Service-Accounts controller and `PUT/GET /config/permissions`, 403 when `isServicePrincipal(principal)`
  (a bot must never manage bots or the permission matrix). This closes the self-escalation/persistence loop
  even if a meta verb is somehow held.
- Track the SA-actor audit gap (issue #141): add the `actorSaId` column so SA-performed management is
  attributable rather than `null`.

## Prevention

Make INV-SA-3 ("never ADMIN-equivalent") code-enforced, not just asserted: a golden test that the SA
grant schema rejects the meta/escalation verbs, and a guard test that a service principal is 403 on the
Service-Accounts and permission-config endpoints. Treat "can grant permissions" and "can manage
principals" as capabilities that, by construction, no non-human principal may hold.

## References

- CWE-269 (Improper Privilege Management), CWE-266 (Incorrect Privilege Assignment).
- OWASP ASVS V4 (access control) — least privilege + no self-grant.
- ADR-0048 (Service Accounts, Fork #3) · ADR-0046 (Roles & Permissions v2) ·
  `docs/06-security/INVARIANTS.md` INV-SA-2 / INV-SA-3 · issue #141 (SA-actor audit column).
