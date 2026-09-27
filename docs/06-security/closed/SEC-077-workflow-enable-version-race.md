---
id: SEC-077
title: Enabling a workflow or authoring a version takes no expected-version precondition — a version authored after a reviewer's look goes live unseen
severity: low
status: fixed
cwe: CWE-367
discovered: 2026-09-24
module: workflow-engine (definitions)
tags: [race, toctou, review-bypass, workflow-engine]
---

# SEC-077 — Workflow enable and version authoring have no optimistic-concurrency precondition

## Summary

`PATCH /workflows/:id { enabled: true }` and `POST /workflows/:id/versions` take no expected version. A
version authored between the moment a reviewer inspects a workflow (builder, dry-run, AI enable card)
and the moment they enable it goes live, and the reviewer never saw it.

## Description

- `WorkflowsService.update` (`workflows.service.ts:111-130`) writes `enabled` with no reference to the
  version the caller reviewed. `UpdateApplicationWorkflowSchema`
  (`packages/shared/src/schemas/workflow.ts:700-708`) has no `expectedVersion` or `expectedUpdatedAt`
  field.
- `authorVersion` (`workflows.service.ts:143-178`) appends `latest + 1` with no base-version check. The
  `(workflowId, version)` unique index prevents duplicate numbers but not a lost review.
- At fire time the trigger resolves the **latest** version of an enabled workflow
  (`run/workflow-trigger.service.ts:68-72`), so whatever is newest when the event fires is what runs.

Sequence: admin A dry-runs version 3 and decides to enable. Admin B (or a `workflow:manage` service
account) authors version 4, with a different REST destination or mapping. A enables, and version 4 is
now live. The AI enable card re-checks its preview before approval (STALE / `PREVIEW_CHANGED`), but the
gap between that check and the route write stays open (`docs/ai-assistant/security.md` "Enable race").
The same applies after enabling: a new version on an enabled workflow takes effect with no second
review. That is by design today, but it has the same root cause.

## Impact

Low. The attacker must already hold `workflow:manage` (ADMIN by default), and with it they could
author and enable a version themselves. The race only defeats a *review* step (four-eyes, or the AI
card's "what you approve is what runs"). It does not escalate privilege. The write is attributed
(`createdById` / `createdBySaId`), so the change is auditable afterwards.

## Proof of concept

Reasoned from the code, **not executed**.

```sh
# t0  reviewer: GET /api/workflows/$W   -> latestVersion.version = 3; dry-run looks fine
# t1  other:    POST /api/workflows/$W/versions {"steps":[ …REST step to a new path/mapping… ]}  -> version 4
# t2  reviewer: PATCH /api/workflows/$W {"enabled":true}  -> 200; the next grant event runs version 4
```

## Affected

At `origin/dev` 62aa1e53.

- `apps/api/src/workflow-engine/definitions/workflows.controller.ts:78-101`: `PATCH :id`, `POST :id/versions`.
- `apps/api/src/workflow-engine/definitions/workflows.service.ts:111-130`, `:143-178`.
- `packages/shared/src/schemas/workflow.ts:700-708`, `:760-762`.

## Recommendation

Minimal fix, additive and optional so existing clients keep working:

- Add an optional `expectedVersion: int` to `UpdateApplicationWorkflowSchema`. When it is present with
  `enabled: true`, run the update in a transaction that reads the latest version number and returns
  **409** if it differs.
- Add an optional `baseVersion: int` to `CreateWorkflowVersionSchema`, with a 409 if it is not the
  current latest (checked inside the existing allocation transaction).
- The web builder and the AI `workflow_set_enabled` tool send the version they showed. Omitting the
  field keeps today's behaviour, so nothing breaks on upgrade and no data changes.

## Prevention

Every "review then act" route (enable, approve, publish) takes the identity of what was reviewed and
refuses with 409 on mismatch. Add a spec: enable with a stale `expectedVersion` returns 409.

## References

- CWE-367 (TOCTOU), CWE-362.
- `docs/ai-assistant/security.md` "Enable race" · ADR-0054 · epic #1315, PR #1354.

## Resolution

**Status**: fixed
**Fixed in**: commit `24ab4201` (`fix(api): honour expectedVersion on workflow update and baseVersion on authoring (#1315)`),
with `8a9d6ace` (shared fields), `e8ba9351` (AI tools) and `631a1973` (web list toggle)
**Fixed by**: lazyit-remediator
**Date**: 2026-09-24

### Changes
- `packages/shared`: optional `expectedVersion` (int ≥ 0) on `UpdateApplicationWorkflowSchema`,
  optional `baseVersion` on `CreateWorkflowVersionSchema`. `0` means "no version authored yet".
- `workflows.service.ts`: with `expectedVersion`, the header update runs in a transaction that takes
  `SELECT … FOR UPDATE` on the `application_workflows` row, re-reads the latest version and throws 409 on
  mismatch. `authorVersion` always takes the same row lock (so it serializes with a checked enable) and
  409s on a stale `baseVersion`. Omitting either field keeps the previous behaviour.
- AI `workflow_set_enabled` sends `expectedVersion`, `workflow_author_version` sends `baseVersion` (the
  version read at run time, after the card's STALE check). The web workflow-list enable toggle sends
  `expectedVersion` from the row's loaded detail.

### Tests added
- `workflows.service.spec.ts` › "SEC-077 version preconditions": stale `expectedVersion` → 409, no
  write; current / `0` → write inside the tx; omitted → unconditioned write; stale `baseVersion` → 409,
  no version; current / omitted → `latest + 1` under the lock. Fails without the fix (no 409).
- `workflow-authoring.tools.spec.ts`: enabling through the AI takes the version-checked path.

### Verification
Charter validation block: shared / api / web / agent `tsc --noEmit` clean; api Jest 252 suites, 5328
tests passed; `packages/shared` (1375) and `apps/web` (1074) `bun test` 0 fail; `apps/agent` has 2
pre-existing failures that need `pwsh` (unrelated). Changed-file eslint (api, web) clean; manual parity OK.
With the implementation files reverted to `origin/dev` and the new specs kept, 18 of the new tests fail.

### Residual risk
- The web **builder** does not send `baseVersion` / `expectedVersion`: it authors its own version on
  every save (last writer wins, as before). Adding it needs the builder to track the loaded version
  across re-saves — a follow-up if four-eyes review in the builder matters.
- A new version on an already-enabled workflow still takes effect with no second review (by design).
