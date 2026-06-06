---
id: SEC-021
title: Last-admin guard bypassed by isActive=false — permanent un-administrable lockout
severity: medium
status: open
cwe: CWE-1390
discovered: 2026-06-06
module: users
tags: [availability, dos, last-admin, rbac, lockout]
---

# SEC-021 — Deactivating the last ADMIN (`isActive=false`) bypasses the last-admin guard

## Summary

`PATCH /users/:id` can set `isActive=false`, which makes a user unable to authenticate, but the
last-admin guard only runs on role demotion / offboard / delete — so setting the only remaining
ADMIN inactive (including yourself) leaves the instance with no usable administrator and no in-app
recovery.

## Description

The codebase enforces "never leave the instance without an administrator" (ADR-0040, INV-7) with
`assertNotLastAdmin`, called before a role demotion (`users.service.ts:262-264`), before offboard
(`users.service.ts:487-489`) and there is also a no-self-role-change guard
(`users.service.ts:257-259`). The guard's own docstring says it is for "any action that would remove
their administrator powers (role demotion, offboarding, delete)".

Deactivation is a fourth such action and is NOT guarded:

- `UpdateUserSchema` accepts `isActive` (`packages/shared/src/schemas/user.ts:105`) and `update`
  writes the body straight through (`this.prisma.user.update({ where: { id }, data })`,
  `users.service.ts:278`). The role-change guards at `users.service.ts:252-265` only run when
  `data.role` changes — an `isActive` toggle skips them entirely, and there is no
  self-deactivation guard analogous to the self-role-change one.
- A deactivated account cannot authenticate: OIDC throws `401 'Account disabled'`
  (`jwt-auth.guard.ts:310-312`) and shim treats it as anonymous (`jwt-auth.guard.ts:246`), so a
  gated route then 403s (`roles.guard.ts:107-109`).

The only way to set `isActive=true` again is `PATCH /users/:id` (`user:manage`, ADMIN). `restore`
does not touch `isActive`. So once the last ADMIN is inactive, no one can authenticate as an ADMIN to
reactivate anyone — the instance is un-administrable until someone edits the database directly. The
common single-admin install (the seeded ADMIN) is the easiest to brick: one self-deactivation.

## Impact

Loss of all administrative capability with no in-product recovery (requires direct DB access to fix).
Reachable by any caller holding `user:manage` (ADMIN) — including the sole admin acting on themselves,
which is exactly the accidental-lockout the existing guards exist to prevent. Availability/integrity of
the IAM control plane; not a confidentiality or privilege-escalation issue. Admin-gated, so the
attacker must already be an administrator (or a service account granted `user:manage`) — that gating is
the main mitigation, hence Medium rather than High.

## Proof of concept

Reasoned, **not executed**. Single-ADMIN instance, shim mode, `<admin>` is the only ADMIN:

```sh
# disable the last admin (own id or the only admin's id)
curl -X PATCH http://localhost:3001/users/<admin-uuid> \
  -H 'content-type: application/json' \
  -H 'X-User-Id: <admin-uuid>' \
  -d '{"isActive": false}'
# 200 OK. From now on every request as <admin> resolves to anonymous (shim) / 401 (OIDC),
# so no ADMIN can reach PATCH /users/:id to set isActive=true again.
```

Compare: `{"role":"MEMBER"}` on the same last admin correctly 409s via `assertNotLastAdmin`; the
`isActive` path does not.

## Affected

- `apps/api/src/users/users.service.ts:249-278` — `update`: role-change guards don't cover `isActive`;
  no last-admin / no-self guard on deactivation.
- `apps/api/src/users/users.service.ts:451-460` — `assertNotLastAdmin` (only called for role/offboard).
- `packages/shared/src/schemas/user.ts:105` — `isActive` accepted in `UpdateUserSchema`.
- `apps/api/src/auth/jwt-auth.guard.ts:246,310-312` — deactivated account loses authentication.

## Recommendation

Treat deactivating an ADMIN as a privilege-removing action:

- In `update`, when the change sets a currently-ADMIN user to `isActive=false`, call
  `assertNotLastAdmin(id)` (409 if they are the last live ADMIN), mirroring the role-demotion path.
- Add a self-deactivation guard mirroring the self-role-change one (an admin cannot set their own
  `isActive=false`), so a second pair of hands is always in the loop.
- Consider a backstop reactivation path (e.g. the first-run `POST /config/setup` already 409s while a
  live ADMIN exists — confirm an operator can recover an all-inactive-admin instance without DB
  surgery, or document the DB recovery step in a runbook).

## Prevention

Centralize the "would this leave zero usable admins?" check so every power-removing transition (role
demote, delete/offboard, **deactivate**, and any future one) goes through the same guard. Add a test
asserting `PATCH {isActive:false}` on the last ADMIN 409s, alongside the existing role-demotion test.

## References

- CWE-1390 (Weak Authentication — here, loss of the recovery path) / CWE-285 (Improper Authorization).
- ADR-0040 (RBAC + last-admin guard) · INVARIANTS INV-7 (first/last ADMIN) ·
  ADR-0041 (restore does not reactivate).
