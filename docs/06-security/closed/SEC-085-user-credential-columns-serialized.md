---
id: SEC-085
title: User reads serialize the whole row, so the argon2id passwordHash and the session epochs reach every user:read and asset:read holder
severity: high
status: closed
cwe: CWE-200
discovered: 2026-09-26
module: users / assets / asset-assignments
tags: [info-leak, credentials, serialization, users, assets]
---

# SEC-085 — User credential columns serialized on every user read

## Summary

`UsersService.serializeUsers` spread the whole Prisma `User` row onto the response and removed only
the two manager columns. `ASSET_RELATIONS` and `AssetAssignmentsService.findAll({ includeUser })`
embedded the owner with `include: { user: true }`. Neither path had an allowlist, and the API has no
global serializer, no Prisma `omit` and no `ZodSerializer`. Every column went out, including
`passwordHash` (argon2id, PHC-encoded), `passwordUpdatedAt`, `sessionEpoch`, `mcpCredentialEpoch`,
`mustChangePassword`, `notificationEmailOptOutTypes`, `directorySourceId`, `directoryOffboardedAt`,
`managerId` and `managerName`.

## Description

`UserSchema` in `@lazyit/shared` documents the wire shape, but nothing enforces it on the way out. Nest
passes the object to `JSON.stringify` as it is. Affected responses:

| Route | Gate | Who reaches it by default |
| --- | --- | --- |
| `GET /users` (every item) | `user:read` | ADMIN, MEMBER, service accounts granted it |
| `GET /users/:id` | `user:read` | same |
| `GET /users/me` | any authenticated human | everyone (own row only) |
| `POST /users`, `PATCH /users/:id`, `PATCH /users/me`, `POST /users/:id/clone`, restore, provision | `user:manage` / self | ADMIN / self |
| `GET /assets/:id` → `activeAssignments[].user` | `asset:read` | **ADMIN, MEMBER, VIEWER**, service accounts |
| `GET /assets/:id/assignments` → `[].user` | `asset:read` | same |

The AI tools and MCP call the same routes (`rt.call`) but project the rows through their own
allowlists (`userSummary`, `owner()`, `resolveOwners`), so model output did not carry the hash. SSE,
notification and email payloads, the search index (`projectUser`), the login response
(`LoginUserSchema`) and the vault member list all use explicit selects and are not affected.

`passwordHash` is non-null only for `AUTH_MODE=local` accounts (ADR-0086). In OIDC mode the leak is
limited to the epochs and internal flags. `mcpCredentialEpoch` exists only on `dev` (ADR-0097).

## Impact

In local mode any VIEWER can read the password hash of every user who owns an asset, admins included.
Any MEMBER can read every user's hash through the directory. The hash can then be cracked offline, and
argon2id only slows this down: a weak or reused password falls, and the attacker gets that account,
possibly an ADMIN. The epochs alone do not let anyone forge a token (tokens are signed with a server
secret), but they are internal revocation state and should not be public. **High**: exploitable with
the lowest role, the impact is credential exposure, and offline cracking can lead to privilege
escalation.

## Proof of concept

Executed through the real Nest HTTP stack (supertest), not only reasoned. The spec is
`apps/api/src/users/users.serialization.http.spec.ts`: the real `UsersController` and `UsersService`,
with Prisma returning a whole row as it does for `findFirst` and `findMany`. Before the fix:

```
GET /users/me  → expect(body).not.toHaveProperty("passwordHash")
Received value: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA"
```

`GET /users` and `GET /users/:id` failed the same way. Against a live local-mode instance:

```sh
curl -s -H "Authorization: Bearer $VIEWER_TOKEN" https://lazyit.example/api/assets/<id> \
  | jq '.activeAssignments[].user.passwordHash'
curl -s -H "Authorization: Bearer $MEMBER_TOKEN" 'https://lazyit.example/api/users?limit=200' \
  | jq '.items[] | {email, passwordHash}'
```

## Affected

- `apps/api/src/users/users.service.ts` `serializeUsers` / `stripManagerColumns` (at `origin/dev`
  7bac56b7 and `origin/master` `3d69b928`, v1.11.0).
- `apps/api/src/assets/assets.service.ts` `ASSET_RELATIONS` (`include: { user: true }`).
- `apps/api/src/asset-assignments/asset-assignments.service.ts` `findAll` (`includeUser`).
- **Released versions: v1.3.0 through v1.11.0 (current `master`).** v1.3.0 added `passwordHash` in
  `7dd43aec` (ADR-0086 F1a). The whole-row spread predates it (`99968f53`, ADR-0058), so the column was
  exposed from the moment it existed.

## Recommendation

Build the User wire shape from an explicit allowlist that matches `UserSchema`, and select embedded
users through the same allowlist.

## Prevention

- `PUBLIC_USER_SELECT` is the single allowlist. A spec pins every key to a `UserSchema` field and
  rejects the credential columns, so a new column does not reach clients until someone adds it on
  purpose.
- Follow-up (not in this fix): add a Prisma client-level `omit` for `passwordHash` and the epochs. The
  auth paths currently read them off the `@CurrentUser` whole row (`PasswordStepUpVerifier`,
  `PasswordLifecycleService`, OAuth consent, the guards), so this needs a dedicated credential read and
  a typed `PrismaService`. That is a cross-module auth refactor and is escalated separately.

## References

- CWE-200, CWE-522. OWASP API3:2023 (Broken Object Property Level Authorization).
- [[0086-local-authentication-mode]], [[0097-ai-assistant-mcp-and-headless-api]], [[0058-user-manager-and-clone-actions]],
  [[user]].

## Resolution

**Status**: fixed
**Fixed in**: commits `d7ab3516` (`fix(api): serialize User through a public column allowlist (SEC-085)`)
and `bb291194` (`fix(api): select asset owners through the public user allowlist (SEC-085)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-09-26

### Changes
- `apps/api/src/users/public-user.ts` (new): `PUBLIC_USER_SELECT`, which holds the `UserSchema`
  columns, plus `pickPublicUserColumns`.
- `apps/api/src/users/users.service.ts`: `serializeUsers` builds the response from
  `pickPublicUserColumns(row)` rather than spreading the row, `stripManagerColumns` is removed, and
  `SerializedUser` is typed from `PublicUserColumns`.
- `apps/api/src/users/users.controller.ts`: the `/me` comment no longer claims the payload carries
  `mustChangePassword`. The web drives the forced-change wall from the 403 code.
- `apps/api/src/assets/assets.service.ts`, `apps/api/src/asset-assignments/asset-assignments.service.ts`:
  the owner is read with `include: { user: { select: PUBLIC_USER_SELECT } }`.

### Tests added
- `apps/api/src/users/users.serialization.http.spec.ts`: `GET /users`, `GET /users/:id` and
  `GET /users/me` bodies contain no credential or internal column, and every key is a `UserSchema`
  field. It fails without the fix (the argon2id string is in the body) and passes with it. A fourth
  test pins `PUBLIC_USER_SELECT` to `UserSchema`.
- `apps/api/src/assets/assets.service.spec.ts`: "findOne reads each owner through the public column
  allowlist — never a credential (SEC-085)". It fails without the fix (`user: true`).
- `apps/api/src/asset-assignments/asset-assignments.service.spec.ts`: "findAll never inlines a
  credential column of the owner (SEC-085)". It fails without the fix.

### Verification
With the fixes stashed, the new and updated specs fail (7 failures). With the fixes in place, the full
API Jest run under Node passes (273 suites, 6030 tests), `tsc` passes for shared, api, web and agent,
and the changed-files eslint reports no errors.

### Residual risk
- No global `omit`: a future `include: { user: true }` or row spread would leak again. The allowlist, its
  spec and the entity-note rule reduce this risk but do not remove it. The client-level `omit` is the
  follow-up above.
- `directoryAttrs` and `externalId` are still on the wire because they are `UserSchema` fields the web
  uses. `directoryAttrs` can hold AD `memberOf` DNs.
- Released instances (v1.3.0–v1.11.0) exposed the hashes until they upgrade. After upgrading, local-mode
  operators should consider resetting passwords that may have been read, admin passwords first.
