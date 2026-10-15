---
id: SEC-022
title: isActive (and other non-mirrored fields) persist on IdP-failure revert despite a 503
severity: low
status: fixed
cwe: CWE-460
discovered: 2026-06-06
module: users
tags: [integrity, write-back, idp, partial-write, inv-5]
---

# SEC-022 — `update` revert is field-scoped, so `isActive` survives a "your change was not saved" 503

## Summary

When a `PATCH /users/:id` changes a non-mirrored field (`isActive`) alongside a mirrored one
(role/name/email) and the Zitadel write-back fails, the local row is reverted ONLY for role/name/email
— `isActive` stays committed even though the request returns a 503 whose public message says the change
was not saved.

## Description

INV-5 promises: on a Management failure "the local change is rolled back … never a silent partial
write". `update` implements the rollback by reverting exactly the fields it might have mirrored:

- the whole body is written first: `const user = await this.prisma.user.update({ where: { id }, data })`
  (`users.service.ts:278`) — this includes `isActive` when present.
- on a mirror failure the revert restores only role / firstName+lastName / email
  (`users.service.ts:322-335`); `isActive` is not in that set.

`isActive` is never mirrored to the IdP (only `roleChanged || profileChanged` triggers the write-back,
`users.service.ts:289`), so a PATCH like `{ firstName: 'X', isActive: false }` whose name mirror throws
will: write both fields, fail the `idp.updateUser` call, revert `firstName`, leave `isActive=false`,
and throw — the controller surfaces the generic 503 ("The identity provider is temporarily unavailable.
Your change was not saved, please try again in a moment."). The deactivation persisted; the message
says nothing did. This is a genuine, if narrow, divergence from INV-5's "rolled back" guarantee — INV-5
enumerates role/name/email as the reverted fields but does not account for a non-mirrored field riding
along in the same PATCH.

## Impact

A user can be left deactivated (or any other non-mirrored future field changed) while the caller is told
the change failed — a confusing, audit-misleading partial write in the IAM path. No privilege gain: the
attacker is already an ADMIN, and the last-admin role guard still runs before the write for role
changes. Low severity: it requires a combined PATCH AND a genuine IdP outage (503 condition), and the
worst outcome is a stale `isActive`/integrity drift, not exposure or escalation. (It does, however,
compound SEC-021: a silent last-admin deactivation behind a "nothing saved" 503.)

## Proof of concept

Reasoned, **not executed** (requires inducing a Zitadel Management failure). With an IdP-linked user and
Zitadel Management unreachable:

```sh
curl -X PATCH http://localhost:3001/users/<id> \
  -H 'content-type: application/json' -H 'X-User-Id: <admin-uuid>' \
  -d '{"firstName": "X", "isActive": false}'
# → 503 "… Your change was not saved …", but the row now has isActive=false (firstName reverted to old).
```

## Affected

- `apps/api/src/users/users.service.ts:278` — full body (incl. `isActive`) written before the mirror.
- `apps/api/src/users/users.service.ts:289` — mirror only on `roleChanged || profileChanged`.
- `apps/api/src/users/users.service.ts:322-335` — revert restores only role/name/email.
- `docs/06-security/INVARIANTS.md` INV-5.

## Recommendation

Make the revert restore the full pre-update snapshot of every field the PATCH touched, not just the
mirrored ones — e.g. capture `current` (already fetched at `users.service.ts:250`) and on failure
revert each key present in `data` back to its `current` value, or perform the local write only AFTER the
mirror succeeds (write-after-mirror) so a failed mirror never persisted anything. Either keeps the 503
message truthful.

## Prevention

When a write path both persists locally and mirrors externally with a "roll back on failure" contract,
the rollback must cover EVERY persisted field, or the local write must follow the external one. Add a
test: a PATCH combining `isActive` with a mirrored field, under a forced mirror failure, must leave the
row byte-identical to before (currently `isActive` would differ).

## References

- CWE-460 (Improper Cleanup on Thrown Exception) / CWE-636 (Not Failing Securely).
- INVARIANTS INV-5 (no-split-brain write-back) · ADR-0043 §3 (write-back) · SEC-021 (last-admin via
  `isActive`).

## Resolution

**Status**: no longer applicable
**Fixed in**: commit `d65e8d713` (`del(api): remove the IdP write-back from the users module (#1543)`),
merged into the epic integration branch by PR #1552; the `IdentityProvider` seam itself went in PR #1554
(epic #1543, [[0102-remove-bundled-zitadel|ADR-0102]] §1 and §6)
**Fixed by**: security review (epic #1543)
**Date**: 2026-10-09

### Changes
- No fix was written for this finding. The path it describes no longer exists: ADR-0102 removed the
  bundled Zitadel, the role and profile write-back, and the revert that ran when the mirror failed.
- `apps/api/src/users/users.service.ts:795` (`update`) now writes the row once
  (`prisma.user.update` at `:861-879`), records history in one transaction (`:906-934`), re-indexes
  search (`:937`) and returns (`:938`). It makes no IdP call, has no revert branch, and cannot throw the
  "Your change was not saved" 503. A PATCH that carries `isActive` with a name, email or role change
  commits all of them or none of them.
- `apps/api/src/users/users.service.ts:958` (`updateOwnProfile`) delegates to `update` with the name keys
  only (`:968`), so it inherits the same single write.
- `apps/api/src/auth/identity/` (the Management client, both adapters and the interface) is deleted;
  `grep -rn "idp\." apps/api/src` returns nothing outside tests.

### Tests added
- None. There is no mirror left to fail, so the regression test the finding asked for has nothing to
  force. The existing `apps/api/src/users/users.service.spec.ts` suite covers the single-write `update`.

### Verification
Read on the integration branch `feat/issue-1543-remove-bundled-zitadel` at `340645acb`. The
`users`, `config` and `auth` Jest suites pass there.

### Residual risk
None for this finding. INV-5, the invariant it measured against, is retired in [[INVARIANTS]].
