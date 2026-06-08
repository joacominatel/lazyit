---
title: WorkflowStepRun
tags: [domain, entity, workflow-engine, access, append-only]
status: accepted
created: 2026-06-08
updated: 2026-06-08
---

# WorkflowStepRun

> 🟢 implemented · Area: Access / Workflow engine (epic #248) · see [[0054-applications-workflow-engine]]

## Purpose

The **per-attempt execution log** of a [[workflow-run]] — strictly append-only, **one immutable row per
step ATTEMPT** (the [[asset-history]] precedent, [[0033-asset-history-event-model]]). It is the engine's
audit trail and report source: *which step ran, on which attempt, with what outcome, and which external
account it touched*. A retry is a **new row** with `attempt + 1`; the **current** state of a step is the
**latest row for `(runId, stepKey)`**. It is never updated or deleted, only appended.

The split is deliberate ([[0054-applications-workflow-engine]] §3): **the [[workflow-run]] is the
idempotency unit; the `WorkflowStepRun` is the retry unit.**

## Relationships

- **belongs to** one [[workflow-run]] (`runId`, **required** FK, `onDelete: Restrict` — the run is
  itself append-only and never hard-deleted).
- **references a step by key** — `stepKey` is the step's stable node key inside the pinned
  [[workflow-version]]'s `steps` jsonb (`stepIndex` is its position in the list). The step is a logical
  node, not its own table.

## Lifecycle / states (`WorkflowStepRunStatus`)

One immutable row per attempt records its terminal classification:

- **`SUCCEEDED`** — the attempt met the step's success criteria (for an HTTP step,
  `isHttpStatusSuccess(status, successCriteria)`).
- **`FAILED`** — the attempt failed (a response outside the success window, a transport error, …);
  after the retry policy is exhausted the run follows the step's `onFailure` edge.
- **`AWAITING_INPUT`** — this attempt suspended the run for a human ([[manual-task]]) or inbound
  callback (no BullMQ job in flight).
- **`SKIPPED`** — the effectively-once guard short-circuited because a prior attempt already
  `SUCCEEDED` (a reconcile/replay does not re-fire a completed step).
- **`COMPENSATED`** — this row records a **compensation** (saga rollback) of the step's external
  effect, written during a `COMPENSATE` pass in reverse completion order. Compensation is best-effort
  and **never touches the [[access-grant]]**.

## Business rules

- **Append-only and immutable.** Rows are written, never updated or deleted — `createdAt` only, no
  `updatedAt` / `deletedAt` ([[0006-soft-delete-and-auditing]]).
- **`externalCorrelationId` makes provisioning effectively-once.** A step captures the external id it
  created (e.g. the created Jira user id) so a later `ACCESS_REVOKED` run deprovisions the **exact**
  account this run created — the correlation that ties create→revoke ([[0054-applications-workflow-engine]] §3).
- **`metadata` is REDACTED outcome data only.** HTTP status, duration, error class, and mapped field
  **names** — **never** request/response bodies, credentials, or mapped PII **values** ([[INVARIANTS]]
  INV-6, [[0031-logging-strategy]]). The orchestrator also records the **resolved transition edge** it
  took (`onSuccess` / `onFailure` target) and any manual / compensation linkage here, keeping the
  per-run timeline self-describing — all within the same redaction discipline.
- **Engine-written, read-only on the wire.** `WorkflowStepRunSchema` is a read shape; there is no
  client create DTO.

## Conventions

- **ID:** `autoincrement()` — a child execution log, never an external handle ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `WorkflowStepRun` → table `workflow_step_runs`. Read schema `WorkflowStepRunSchema` lives
in `@lazyit/shared` (`packages/shared/src/schemas/workflow.ts`, [[shared-package]]).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | `@default(autoincrement())`; internal, never exposed. |
| `runId` | `cuid` | FK → [[workflow-run]], required, `onDelete: Restrict`. |
| `stepIndex` | `int` | the step's position in the pinned version's step list. |
| `stepKey` | `string` | the step's stable node key within the [[workflow-version]] `steps` jsonb. |
| `attempt` | `int` | 1-based; a retry is a new row with `attempt + 1`. |
| `status` | `WorkflowStepRunStatus` | the attempt's terminal classification. |
| `externalCorrelationId` | `string?` | the captured external id (e.g. created account id) for effectively-once deprovision. |
| `metadata` | `jsonb?` | **redacted** outcome data only (status, duration, error class, field *names*, transition taken). |
| `createdAt` | `datetime` | `@default(now())`. |

Index: `@@index([runId, id])` (the per-run step timeline).

## Endpoints

A step run has **no standalone controller** — it is surfaced **nested in the run detail**:

- `GET /workflow-runs/:id` returns the [[workflow-run]] plus its **ordered `steps`** (the attempt
  rows), each projected with the DAG transition it took. `@RequirePermission('workflow:read')`.

The rows are written by the step handlers (`handlers/rest.handler.ts`, `webhook-out.handler.ts`,
`manual.handler.ts`) as the `run/workflow-run.orchestrator.ts` walks the graph.

## Not yet implemented (deferred)

- A **retention / archival** policy for the growing per-attempt log is a Phase-2 follow-up
  ([[0054-applications-workflow-engine]] Consequences).

Related: [[workflow-run]] · [[workflow-version]] · [[manual-task]] · [[application-workflow]] ·
[[access-grant]] · [[asset-history]] · [[shared-package]] · [[0054-applications-workflow-engine]] ·
[[0033-asset-history-event-model]] · [[0031-logging-strategy]] · [[0006-soft-delete-and-auditing]] ·
[[0005-id-strategy]] · [[INVARIANTS]]
