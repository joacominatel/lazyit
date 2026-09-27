---
id: SEC-078
title: Dry-run renders an offboarded (soft-deleted) sample grantee's personal details — the user include has no soft-delete filter
severity: low
status: fixed
cwe: CWE-359
discovered: 2026-09-24
module: workflow-engine (dry-run)
tags: [soft-delete-bypass, pii, workflow-engine]
---

# SEC-078 — The dry-run's grantee include skips the soft-delete filter

## Summary

`POST /workflow-runs/dry-run` resolves `sampleAccessGrantId` with a nested `user` include that has no
`deletedAt` filter. It projects an offboarded person's email, name, legajo and username into the
rendered preview, although the same projection blanks an offboarded *manager* (ADR-0058 §3).

## Description

`WorkflowDryRunService.buildContext` (`dry-run/workflow-dry-run.service.ts:207-260`) calls
`accessGrant.findFirst({ where: { id } , include: { user: { select: … } } })`. The soft-delete extension
scopes only the top-level operation, and `AccessGrant` itself is not soft-deleted (it has
`revokedAt`), so neither the grant nor the nested `User` is filtered. The select does not load
`user.deletedAt`, so `projectGrantee` (`run/grantee-projection.ts:34-70`) cannot tell. It redacts an
offboarded manager (`isOffboarded`) but has no equivalent for the grantee. The grant's `revokedAt` is
not checked either, so a revoked grant of a departed employee is a valid sample.

This is the SEC-040 / SEC-071 class (nested relation bypasses the top-level soft-delete filter) in a new
module.

## Impact

Low. The caller needs `workflow:manage` (ADMIN by default) and a grant id from the same application.
An ADMIN can usually see offboarded users by other means, so the new exposure is small. The issue is
that a retention-scoped PII surface (ADR-0058) renders a departed person's details in a preview. Through
the AI enable card (#1354) those details also reach the model context. The card is refused when the
tool can see the grantee is offboarded, but without `user:read` it cannot check
(`docs/ai-assistant/security.md` "Offboarded sample grantees").

## Proof of concept

Reasoned from the code, **not executed**.

```sh
# G = an access grant (revoked or not) on app A whose user has deletedAt set.
curl -X POST /api/workflow-runs/dry-run -H "Authorization: Bearer <admin>" \
  -d '{"workflowId":"'$W'","sampleAccessGrantId":"'$G'"}'
# -> 200; request previews render grantee.email / firstName / lastName / legajo / username of the offboarded user
```

## Affected

At `origin/dev` 62aa1e53.

- `apps/api/src/workflow-engine/dry-run/workflow-dry-run.service.ts:207-236`: include without `deletedAt`, with no `revokedAt` check.
- `apps/api/src/workflow-engine/run/grantee-projection.ts:34-70`: no grantee-offboarded branch.

## Recommendation

Minimal fix: add `deletedAt: true` to the `user` select and refuse with 400 when it is set (for example
"The sample grant's grantee is offboarded — pick a grant of an active user"), as the AI card already
does. It is also reasonable to refuse a revoked grant (`revokedAt != null`) as a sample. The change is
read-only and does not affect data. A dry-run that used such a sample now returns 400, and the web
dry-run picker should list only live grants.

## Prevention

Treat every nested `user` include in the workflow engine as needing an explicit `deletedAt` decision
(select it and branch). This is the shared "filter nested includes" fix recommended for the systemic
soft-delete class (summary, top finding 6).

## References

- CWE-359 (Exposure of Private Personal Information).
- ADR-0058 §3 · [[SEC-040-soft-deleted-parent-leaks-via-asset-includes|SEC-040]] ·
  [[SEC-071-dashboard-soft-delete-relation-bypass|SEC-071]] · `docs/ai-assistant/security.md` · epic #1315, PR #1354.

## Resolution

**Status**: fixed
**Fixed in**: commit `1c84fccb` (`fix(api): dry-run refuses offboarded or revoked samples and redacts header values (#1315)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-09-24

### Changes
- `workflow-dry-run.service.ts` `buildContext`: selects `user.deletedAt` on the nested include and
  returns 400 ("The sample grant's grantee is offboarded — pick a grant of an active user") when set,
  and 400 for a revoked grant (`revokedAt != null`). Read-only; no data touched. The web dry-run picker
  already lists only active grants.

### Tests added
- `workflow-dry-run.service.spec.ts` › "SEC-078 sample grant must be live": offboarded grantee → 400;
  the include selects `user.deletedAt`; revoked grant → 400; a live grant of an active user still
  previews. The 400 tests fail without the fix (the preview rendered).

### Verification
Charter validation block: shared / api / web / agent `tsc --noEmit` clean; api Jest 252 suites, 5328
tests passed; `packages/shared` (1375) and `apps/web` (1074) `bun test` 0 fail; `apps/agent` has 2
pre-existing failures that need `pwsh` (unrelated). Changed-file eslint (api, web) clean; manual parity OK.
With the implementation files reverted to `origin/dev` and the new specs kept, 18 of the new tests fail.

### Residual risk
None for this route. The AI enable card's own `GET /users/:id` check stays as a second layer.
