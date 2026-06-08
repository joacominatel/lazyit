---
title: WorkflowRun
tags: [domain, entity, workflow-engine, access, append-only, async]
status: accepted
created: 2026-06-08
updated: 2026-06-08
---

# WorkflowRun

> 🟢 implemented · Area: Access / Workflow engine (epic #248) · see [[0054-applications-workflow-engine]]

## Purpose

The **execution ledger** — one row per fired access event, the durable record of *what the engine did*
about a grant change. It is the [[access-grant]] precedent (append-only **with lifecycle markers**):
never deleted and identity-immutable, but `status` + timestamps transition as the run executes. It is
also the **transactional-outbox row** and the **idempotency unit** of the engine
([[0054-applications-workflow-engine]] §3, [[0053-async-workers-bullmq-valkey]]).

> [!important] The decoupling invariant — the engine fires AFTER the grant commits (INV-5, inverse)
> The `PENDING` run is written **inside** the [[access-grant]] `$transaction` (the outbox row, keyed by
> the unique `idempotencyKey`); after commit `WorkflowTriggerService.enqueue` best-effort enqueues a
> `{ workflowRunId }` BullMQ job and the `workflow-run.sweeper` covers the crash / broker-down window.
> The engine therefore fires **after** the grant commits, **never inside it**, and a failing enqueue is
> **swallowed** (the run stays `PENDING`; the sweeper re-enqueues). A failing external call **never**
> rolls back, blocks or 503s the grant — the deliberate **inverse** of the Zitadel strong-coupling
> ([[0043-zitadel-source-of-truth]] / [[INVARIANTS]] INV-5). The grant is the durable audit fact; an
> un-provisioned external account is a recoverable `FAILED` run + notification, not a split-brain.

## Relationships

- **belongs to** one [[application-workflow]] (`workflowId`, FK, `onDelete: Restrict`) and **pins** the
  exact [[workflow-version]] it executed (`workflowVersionId`, FK, `onDelete: Restrict`) — replay/audit.
- **denormalizes** its [[application]] (`applicationId`, FK, `onDelete: Restrict`) for cheap
  "runs for this app" reporting (the per-app history / dashboard) without a join through the workflow.
- **is caused by** an optional [[access-grant]] (`accessGrantId`, `onDelete: Restrict`) — the source
  event for `ACCESS_GRANTED` / `ACCESS_REVOKED`; nullable for a future pure `SCHEDULED` run.
- **triggered by** an optional [[user]] (`triggeredById`, `@db.Uuid`, `SetNull`) **XOR**
  [[service-account]] (`triggeredBySaId`, `SetNull`) — **the cause**, inherited from the grant's actor.
- **executes as** an optional engine [[service-account]] (`executedAsServiceAccountId`, `SetNull`,
  relation `WorkflowRunExecutedAsSa`) — **the principal the run acts as** for any lazyit-side audited
  effect, pinned from [[application-workflow]] at run creation.
- **has** N [[workflow-step-run]]s (per-attempt log) and N [[manual-task]]s (human pauses).

## Lifecycle / states (`WorkflowRunStatus`)

`PENDING → RUNNING → AWAITING_INPUT → SUCCEEDED | FAILED | COMPENSATED`.

- **`PENDING`** — created (the durable outbox row, written in the grant tx), not yet picked up.
- **`RUNNING`** — a worker is advancing a step.
- **`AWAITING_INPUT`** — paused on a [[manual-task]] / inbound callback. **The load-bearing pause:**
  **no BullMQ job is in flight** — the run parks in Postgres and the worker is freed, so a multi-day
  human wait costs **one row, not a worker** (which is why the engine needs no Temporal).
- **`SUCCEEDED`** — terminal; all steps done (`END_SUCCESS`).
- **`FAILED`** — terminal; a step failed terminally (`STOP_FAIL`). **The grant is NEVER touched.**
- **`COMPENSATED`** — terminal; the saga rollback of already-applied **external** effects ran (never
  the grant).

The walk is driven by `run/workflow-run.orchestrator.ts` over the pinned `steps`, using the shared
`resolveStepTransitions()` (the §8 execution semantics).

## Business rules

- **Idempotency: at most one run per grant event.** The unique `idempotencyKey`
  (`"<trigger>:<accessGrantId>"`) yields **at most one** `WorkflowRun` per grant event. **Retries live
  *inside* a run** as [[workflow-step-run]] `attempt` rows, never as new runs — **the run is the
  idempotency unit; the step is the retry unit** ([[0054-applications-workflow-engine]] §3). A full
  unique index (no soft delete here, so no ghost-row concern).
- **Engine-written; no client create DTO.** The `WorkflowRun` wire shape is **read-only**
  (`WorkflowRunSchema`); runs are created by the engine, never by an API caller.
- **Dual actor attribution, two independent axes.** The *triggering* actor (human XOR SA,
  `triggeredById` / `triggeredBySaId`) is governed by an at-most-one-actor **CHECK** in the migration
  ([[0048-service-accounts]]). The *executing* principal (`executedAsServiceAccountId`) is a
  **separate axis** and is deliberately **NOT** part of that CHECK.
- **Redacted `error` only.** A `FAILED` run's `error` jsonb is a redacted summary (error class + step
  key) — **never** bodies / secrets / PII ([[INVARIANTS]] INV-6, [[0031-logging-strategy]]).
- **Postgres is the system of record.** Run state, the pinned version, the idempotency key and the
  ledger live in Postgres; a BullMQ job carries only `{ workflowRunId }`. A Valkey flush is a
  **reconcile/replay**, never data loss ([[0053-async-workers-bullmq-valkey]],
  [[0054-applications-workflow-engine]] §2).

## Conventions

- **ID:** `cuid()` — an exposed ledger row ([[0005-id-strategy]]).
- **Timestamps:** `createdAt`, `updatedAt` — **no `deletedAt`**. An append-only ledger with lifecycle
  markers (the [[access-grant]] posture): `status` / `startedAt` / `finishedAt` transition, but the row
  is never deleted ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `WorkflowRun` → table `workflow_runs`. Read schema `WorkflowRunSchema` lives in
`@lazyit/shared` (`packages/shared/src/schemas/workflow.ts`, [[shared-package]]); there is **no**
client create DTO.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `workflowId` | `cuid` | FK → [[application-workflow]], `onDelete: Restrict`. |
| `workflowVersionId` | `int` | FK → [[workflow-version]] (the **pinned** version), `onDelete: Restrict`. |
| `applicationId` | `cuid` | FK → [[application]] (denormalized for reporting), `onDelete: Restrict`. |
| `trigger` | `WorkflowTrigger` | the firing event. |
| `accessGrantId` | `cuid?` | FK → [[access-grant]], `onDelete: Restrict`; `null` for a future `SCHEDULED` run. |
| `idempotencyKey` | `string` | `@unique`; `"<trigger>:<accessGrantId>"` for grant-derived triggers. |
| `status` | `WorkflowRunStatus` | `@default(PENDING)`. |
| `triggeredById` | `uuid?` | FK → [[user]] (`@db.Uuid`), `SetNull`; the **human** cause. At-most-one-actor CHECK with `triggeredBySaId`. |
| `triggeredBySaId` | `cuid?` | FK → [[service-account]], `SetNull`; the **non-human** cause. |
| `executedAsServiceAccountId` | `cuid?` | FK → [[service-account]], `SetNull`; the engine principal (separate axis, **not** in the CHECK). |
| `startedAt` | `datetime?` | set when execution begins. |
| `finishedAt` | `datetime?` | set on a terminal status. |
| `error` | `jsonb?` | **redacted** failure summary (class + step key); never bodies/secrets/PII. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |

Indexes: `@@index([applicationId])`, `@@index([workflowId])`, `@@index([accessGrantId])`,
`@@index([status])` (the operator "failed runs" view); plus the at-most-one-actor CHECK on
(`triggeredById`, `triggeredBySaId`).

## Endpoints

`apps/api/src/workflow-engine/runs/` (`workflow-runs.controller.ts`); ADMIN-only in the seed. **Reads
only** — runs are engine-written:

- `GET /workflow-runs` — list / page (filterable). `@RequirePermission('workflow:read')`.
- `GET /workflow-runs/:id` — the run detail **plus its ordered [[workflow-step-run]] attempts**, each
  projected with the DAG transition it took. `workflow:read`.

## Not yet implemented (deferred)

- **Timer-triggered runs** (`accessGrantId = null` for `SCHEDULED` / `TIMER_AFTER_GRANT` /
  `RECERTIFICATION`) — the column is nullable for them, but the timer phase is reserved
  ([[0054-applications-workflow-engine]] §7).
- A **retention / archival** policy for the growing ledger is a Phase-2 follow-up.

Related: [[application-workflow]] · [[workflow-version]] · [[workflow-step-run]] · [[manual-task]] ·
[[workflow-connection]] · [[access-grant]] · [[application]] · [[user]] · [[service-account]] ·
[[shared-package]] · [[0054-applications-workflow-engine]] · [[0053-async-workers-bullmq-valkey]] ·
[[0048-service-accounts]] · [[0043-zitadel-source-of-truth]] · [[0031-logging-strategy]] ·
[[0023-access-management-design]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[INVARIANTS]]
