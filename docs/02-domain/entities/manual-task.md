---
title: ManualTask
tags: [domain, entity, workflow-engine, access]
status: accepted
created: 2026-06-08
updated: 2026-06-08
---

# ManualTask

> 🟢 implemented · Area: Access / Workflow engine (epic #248) · see [[0054-applications-workflow-engine]]

## Purpose

The **human-in-the-loop pause** of a [[workflow-run]]. When a run reaches a `MANUAL` step — or an
`onFailure` edge resolves to `ESCALATE_TO_MANUAL` — the engine creates a `ManualTask`, transitions the
run to **`AWAITING_INPUT`**, and lets the BullMQ job complete (**no held worker** — the pause costs one
Postgres row). The task is surfaced through the notification bell / SSE inbox; on completion the typed
`input` is fed back into the run, which re-enqueues a resume job and continues the walk. This is how a
multi-day human wait ("which team should this user be in?") costs **one row, not a parked worker**
([[0054-applications-workflow-engine]] §8).

## Relationships

- **belongs to** one [[workflow-run]] (`runId`, **required** FK, `onDelete: Restrict` — the run carries
  the timeline and is append-only).
- **references a step by key** — `stepKey` is the suspended step's stable node key in the pinned
  [[workflow-version]], **where the typed-input schema is defined** (see below).
- **assigned to** an optional [[user]] (`assigneeId`, `@db.Uuid`, `SetNull`, relation
  `ManualTaskAssignee`); when `null`, the task is offered to a **`cohort`** (a role/team label).
- **completed by** an optional [[user]] (`completedById`, `@db.Uuid`, `SetNull`) **XOR**
  [[service-account]] (`completedBySaId`, `SetNull`) — honest completion attribution.

## Lifecycle / states (`ManualTaskStatus`)

`PENDING → COMPLETED | CANCELLED`.

- **`PENDING`** — open and awaiting a human; the parent run sits in `AWAITING_INPUT`.
- **`COMPLETED`** — the human **submitted** valid `input` (or **skipped** data entry); the run resumes
  (`RUNNING`) and walks the step's `onSuccess` edge.
- **`CANCELLED`** — the human **failed** the task; the run resumes down the `onFailure` edge (a `MANUAL`
  step's `onFailure`; an escalated-failure task stops the run).

`COMPLETED` / `CANCELLED` are **statuses, not a soft delete** — which is why this entity carries **no
`deletedAt`** (a mutable lifecycle entity, [[0006-soft-delete-and-auditing]]).

## Business rules

- **`origin` and `inputFields` are DERIVED read-shape fields, not stored columns.** The read API
  projects `origin` (`MANUAL_STEP` | `ESCALATED_FAILURE`) **off the pinned step's kind** (no column),
  and resolves the input form from the `MANUAL` step's declared `inputFields` in the
  [[workflow-version]] (an escalated-failure task gets a synthetic note form). Completion validates the
  human's `input` against that form as **untrusted data** — never an expression (no SSTI), and
  redaction-sensitive.
- **`input` may contain PII → never logged.** The value(s) the human provided are fed back into the run
  on completion and are treated as **sensitive** ([[INVARIANTS]] INV-6, [[0031-logging-strategy]]).
  `null` until completed.
- **Completion requires `workflow:task` AND an assignee/cohort match.** Permission alone is the IDOR
  trap — the assignee/cohort match is the second factor ([[0046-roles-permissions-v2]]).
- **Completion attribution is human XOR service account.** An at-most-one-actor **CHECK** in the
  migration enforces that at most one of (`completedById`, `completedBySaId`) is set
  ([[0048-service-accounts]]).
- **v1 scope: typed input + STATIC suggestions only.** A `MANUAL` step's fields collect typed input
  with **admin-typed** static suggestions — **never** a directory / role / team / manager / AD lookup.
  "Which team? / which manager?" is *itself* a manual task; the identity layer is a future model-first
  ADR, **not** this engine (anti-IGA scope, [[0054-applications-workflow-engine]] §6c).

## Conventions

- **ID:** `cuid()` — a mutable lifecycle entity ([[0005-id-strategy]]).
- **Timestamps:** `createdAt`, `updatedAt` — **no `deletedAt`** (status is the lifecycle,
  [[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `ManualTask` → table `manual_tasks`. Validation schemas (`ManualTaskSchema`,
`CompleteManualTaskSchema`, the step-config `ManualInputFieldSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/workflow.ts`, [[shared-package]]).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `runId` | `cuid` | FK → [[workflow-run]], required, `onDelete: Restrict`. |
| `stepKey` | `string` | the suspended step's node key in the pinned [[workflow-version]]. |
| `assigneeId` | `uuid?` | FK → [[user]] (`@db.Uuid`), `SetNull`; optional direct assignee. |
| `cohort` | `string?` | optional cohort (role/team label) when not directly assigned. |
| `prompt` | `string` | what the human must do / answer. |
| `input` | `jsonb?` | the human-provided value(s); **PII-sensitive, never logged**; `null` until completed. |
| `status` | `ManualTaskStatus` | `@default(PENDING)`. |
| `completedById` | `uuid?` | FK → [[user]] (`@db.Uuid`), `SetNull`; the **human** resolver. At-most-one-actor CHECK with `completedBySaId`. |
| `completedBySaId` | `cuid?` | FK → [[service-account]], `SetNull`; the **non-human** resolver. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |

Indexes: `@@index([runId])`, `@@index([assigneeId, status])`, `@@index([status])` (the inbox); plus the
at-most-one-actor CHECK on (`completedById`, `completedBySaId`).

> [!note] Read-shape projection — no `origin` / `inputFields` columns
> `origin` (`MANUAL_STEP` | `ESCALATED_FAILURE`) and the input form (`inputFields` + static
> `suggestions`) are **computed** from the pinned [[workflow-version]] step at read time, not stored on
> the row. This keeps the task lean while the bell/inbox renders a full form — flagged for CTO awareness
> should the engine later need to *query* tasks by origin.

## Endpoints

`apps/api/src/workflow-engine/tasks/` (`manual-tasks.controller.ts`, mounted at `workflow-tasks`);
ADMIN-only in the seed:

- `GET /workflow-tasks` — list (default `PENDING`; filter by `status` / `applicationId`; paginated).
  `@RequirePermission('workflow:read')`.
- `GET /workflow-tasks/:id` — the task + derived `origin` + input form + suggestions. `workflow:read`.
- `POST /workflow-tasks/:id/submit` — submit the typed `input` → `COMPLETED`, resume at `onSuccess`.
  `@RequirePermission('workflow:task')`.
- `POST /workflow-tasks/:id/skip` — skip data entry → `COMPLETED`, continue at the success edge.
  `workflow:task`.
- `POST /workflow-tasks/:id/fail` — fail the task → `CANCELLED`, resume down the failure edge.
  `workflow:task`.

## Not yet implemented (deferred)

- A directory-backed assignee / role / team / manager resolution is a **future model-first ADR**,
  explicitly **out of scope** here ([[0054-applications-workflow-engine]] §6c).

Related: [[workflow-run]] · [[workflow-version]] · [[workflow-step-run]] · [[application-workflow]] ·
[[user]] · [[service-account]] · [[shared-package]] · [[0054-applications-workflow-engine]] ·
[[0048-service-accounts]] · [[0046-roles-permissions-v2]] · [[0031-logging-strategy]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
