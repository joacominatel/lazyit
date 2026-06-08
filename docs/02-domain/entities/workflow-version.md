---
title: WorkflowVersion
tags: [domain, entity, workflow-engine, access, append-only]
status: accepted
created: 2026-06-08
updated: 2026-06-08
---

# WorkflowVersion

> 🟢 implemented · Area: Access / Workflow engine (epic #248) · see [[0054-applications-workflow-engine]]

## Purpose

The **immutable, replayable definition snapshot** of an [[application-workflow]] — the
[[article-version]] precedent ([[0042-article-versioning-and-linking]]) applied to automation. Every
edit **APPENDS a new version**; a [[workflow-run]] **pins** the exact `workflowVersionId` it executed,
so editing a definition never corrupts an in-flight or paused run. The step graph is embedded as a
zod-validated jsonb `steps` ([[0007-flexible-asset-specs-jsonb]]) — atomically snapshot-able as one
unit. A *step* is a **logical node inside the jsonb, not a table**.

## Relationships

- **belongs to** one [[application-workflow]] (`workflowId`, **required** FK, `onDelete: Restrict` — a
  workflow with version history can't be hard-deleted; mirrors [[article-version]] → [[article]]).
- **authored by** an optional [[user]] (`createdById`, `@db.Uuid`, `onDelete: SetNull`) **XOR** a
  [[service-account]] (`createdBySaId`, `onDelete: SetNull`) — honest authorship attribution.
- **is executed by** N [[workflow-run]]s — each run pins this exact version (`workflowVersionId`).

## The step graph (`steps` jsonb) — an opinionated error-handling DAG

`steps` is the frozen definition: a zod **discriminated list** (`WorkflowStepsSchema`) keyed on step
`kind` (`REST` | `WEBHOOK_OUT` | `MANUAL`). It is a **directed acyclic graph with first-class
success/failure edges** — but a deliberately **finite, opinionated** one, **not** an n8n-style
free-form business-condition canvas ([[0054-applications-workflow-engine]] §8). The **degenerate** DAG
(a plain ordered array, no explicit edges) is exactly the old linear sequence, so the common case
stays trivial to author. The entry node is **`steps[0]`**. Each step carries three additive, optional
dimensions:

- **Success criteria** — an HTTP step (`REST` / `WEBHOOK_OUT`) carries an optional `successCriteria`
  (status codes + inclusive ranges). A response **outside** the set (e.g. `500`, `404`) is a step
  **FAILURE**, never a silent "succeeded because we got a response". Unset ⇒ the **`2xx`** default
  (`DEFAULT_HTTP_SUCCESS_RANGE`). The shared predicate `isHttpStatusSuccess()` is the single classifier
  both `api` (executor) and `web` (builder preview) use.
- **Retry policy** — an optional `retry` = `{ maxAttempts (1–10, default 1), backoff (fixed |
  exponential), delayMs (≤ 1h) }`. The contract carries the policy; the BullMQ worker executes the
  attempts. A retry only happens when the handler marked the failure `retryable`; `maxAttempts` caps
  **how many**, the handler gates **whether**. Omitting `retry` ⇒ a single attempt.
- **Transitions** — optional `onSuccess` / `onFailure` edges to a sibling step **key** or a **terminal
  token**. There are **no** arbitrary boolean / expression edges in v1 — the only branch points are
  *success* and *failure-after-retries*:
  - `onSuccess` → a step `key` | **`END_SUCCESS`** (run `SUCCEEDED`). Unset ⇒ the next step in order,
    else `END_SUCCESS`.
  - `onFailure` → a step `key` (alert / compensation / handler) | **`ESCALATE_TO_MANUAL`** (spawn a
    [[manual-task]], run `AWAITING_INPUT`) | **`COMPENSATE`** (saga rollback, run `COMPENSATED`) |
    **`STOP_FAIL`** (run `FAILED` + `workflow.run_failed` alert). Unset ⇒ legacy `onError`, else
    `STOP_FAIL`.

The legacy flat `onError` enum (`fail` / `continue` / `manual`) is **kept on the wire and superseded**:
it is the fallback when `onFailure` is unset, mapped canonically (`fail → STOP_FAIL`,
`continue → take the success edge`, `manual → ESCALATE_TO_MANUAL`) by the shared
`resolveStepTransitions()` — the single source the orchestrator implements (it does not re-derive).

**DAG validity is enforced at the contract edge** (zod refinements + tests): 1–50 steps; step `key`s
are **unique** within a version (a [[workflow-step-run]] references a step by key) and may **not**
collide with a reserved terminal token; every explicit edge resolves to a known key or the right
*kind* of terminal; and the **effective** graph (after default + legacy resolution) is **acyclic**
(DFS three-colour cycle detection) — which guarantees the orchestrator's walk **terminates**.

## Business rules

- **Append-only and immutable.** Rows are written, never updated or deleted — no `updatedAt` /
  `deletedAt` ([[0006-soft-delete-and-auditing]]). The `steps` jsonb is frozen at author time.
- **`(workflowId, version)` is the natural key** (`@@unique`) — the human handle ("v3") and the
  per-workflow timeline. `version` is **monotonic per-workflow** (1, 2, 3, …), allocated **server-side**
  (the `CreateWorkflowVersion` DTO carries only `steps`).
- **Author attribution is human XOR service account.** An at-most-one-actor **CHECK** in the migration
  enforces that at most one of (`createdById`, `createdBySaId`) is set ([[0048-service-accounts]],
  the [[article-version]] precedent).

## Conventions

- **ID:** `autoincrement()` — an append-only definition table, never an external handle; the externally
  meaningful key is `(workflowId, version)` ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `WorkflowVersion` → table `workflow_versions`. Validation schemas
(`WorkflowVersionSchema`, `CreateWorkflowVersionSchema`, the step union `WorkflowStepsSchema` /
`WorkflowStepSchema`) live in `@lazyit/shared` (`packages/shared/src/schemas/workflow.ts`,
[[shared-package]]).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | `@default(autoincrement())`; internal, never exposed. |
| `workflowId` | `cuid` | FK → [[application-workflow]], required, `onDelete: Restrict`. |
| `version` | `int` | monotonic per-workflow revision; server-allocated. |
| `steps` | `jsonb` | the frozen, zod-validated step DAG (immutable). |
| `createdById` | `uuid?` | FK → [[user]] (`@db.Uuid`), `onDelete: SetNull`; the **human** author. At-most-one-actor CHECK with `createdBySaId`. |
| `createdBySaId` | `cuid?` | FK → [[service-account]], `onDelete: SetNull`; the **non-human** author. |
| `createdAt` | `datetime` | `@default(now())`. |

Constraints: `@@unique([workflowId, version])`; the at-most-one-actor CHECK on
(`createdById`, `createdBySaId`).

## Endpoints

A version has **no standalone controller** — it is authored and read through its
[[application-workflow]] (`apps/api/src/workflow-engine/definitions/`):

- `POST /workflows/:id/versions` — author a new version (the engine allocates `version`, validates the
  step graph reachability + connection refs, then freezes `steps`). `@RequirePermission('workflow:manage')`.
- `GET /workflows/:id` — the workflow detail surfaces the **`latestVersion`** (the active definition).
- Each [[workflow-run]] pins and replays the exact `workflowVersionId` it executed.

## Not yet implemented (deferred)

- Richer edge predicates, parallel fan-out (BullMQ Flows) and extra terminals are deliberately out of
  v1 — addable later by **extending the zod step shape, never a table migration**
  ([[0007-flexible-asset-specs-jsonb]], [[0054-applications-workflow-engine]] §8).

Related: [[application-workflow]] · [[workflow-connection]] · [[workflow-run]] · [[workflow-step-run]] ·
[[manual-task]] · [[user]] · [[service-account]] · [[shared-package]] ·
[[0054-applications-workflow-engine]] · [[0042-article-versioning-and-linking]] ·
[[0007-flexible-asset-specs-jsonb]] · [[0048-service-accounts]] · [[0033-asset-history-event-model]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
