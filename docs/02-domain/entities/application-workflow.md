---
title: ApplicationWorkflow
tags: [domain, entity, workflow-engine, access]
status: accepted
created: 2026-06-08
updated: 2026-06-08
---

# ApplicationWorkflow

> 🟢 implemented · Area: Access / Workflow engine (epic #248) · see [[0054-applications-workflow-engine]]

## Purpose

The **opt-in binding** that says "[[application]] X automates trigger T" — the toggle that turns an
[[access-grant]] into an external provisioning/deprovisioning effect. It is the entry point of the
Applications Workflow Engine ([[0054-applications-workflow-engine]]): an [[application]] *may* own one
live workflow per `(application, trigger)` pair that provisions / deprovisions the user in the
external system when access changes inside lazyit.

The **load-bearing default is opt-in**: an application with **no enabled workflow behaves exactly as
today** ([[0023-access-management-design]]) — granting access just records the [[access-grant]], one
indexed lookup of overhead, and nothing fires (`WorkflowTriggerService.planForTrigger` returns `null`).

## Relationships

- **belongs to** one [[application]] (`applicationId`, **required** FK, `onDelete: Restrict` — an app
  with workflow history can't be hard-deleted; soft delete bypasses it, mirroring [[access-grant]]).
- **fires on** a `trigger` — an access-lifecycle event ([[access-grant]] created / revoked).
- **executes as** an optional engine [[service-account]] (`executedAsServiceAccountId`,
  `onDelete: SetNull`) — the dedicated least-privilege principal the run acts as for any lazyit-side
  audited effect ([[0048-service-accounts]]). Never a fabricated human, never ADMIN.
- **has** N [[workflow-version]]s — the append-only definition history. The **active** definition is
  the *latest* version (no denormalized pointer, which avoids a circular FK); the workflow detail
  surfaces it as `latestVersion`, and each [[workflow-run]] snapshots and **pins** the version it
  executed.
- **has** N [[workflow-run]]s — the execution ledger, one row per fired event.

## Business rules

- **Opt-in / disabled by default.** `enabled` defaults to `false`, so a freshly-created or draft
  workflow is inert until explicitly enabled. A disabled workflow never fires; the grant path still
  does nothing extra ([[0054-applications-workflow-engine]] §1).
- **At most one LIVE workflow per `(applicationId, trigger)`.** A **partial unique index**
  `WHERE "deletedAt" IS NULL` (raw SQL in the migration — Prisma can't express it; **not** an
  `@@unique`, which would re-introduce the ghost-row collision) makes "the engine fires the workflow
  that matches" deterministic, while a soft-deleted binding **frees the slot** for reuse/replace
  ([[0041-soft-delete-reuse-and-restore]]).
- **The trigger and application are immutable.** Only `name`, `description`, `enabled`,
  `deprovisionPolicy` and `executedAsServiceAccountId` are mutable (the `UpdateApplicationWorkflow`
  DTO is a `partial`). To change the `(application, trigger)` pair, recreate the binding.
- **The binding has no creator column.** Author attribution lives on each [[workflow-version]]
  (human-XOR-SA) — the [[article]] / [[article-version]] split.
- **v1 triggers only.** A workflow may be **created** against `ACCESS_GRANTED` / `ACCESS_REVOKED`
  only (`WorkflowTriggerV1Schema`); `TIMER_AFTER_GRANT` / `SCHEDULED` / `RECERTIFICATION` are
  **reserved enum slots with no behavior** — present so the later timer phase needs no enum migration.
- **Multi-grant deprovision policy is enforced.** Because a user may hold several active grants on one
  app ([[0023-access-management-design]], no uniqueness), `deprovisionPolicy` decides when an
  `ACCESS_REVOKED` workflow cuts external access. Default **`LAST_ACTIVE_GRANT`** (safer —
  `WorkflowTriggerService` only fires a deprovision when the *last* active grant for that user+app is
  revoked, never cutting off a user who still holds legitimate access); `EACH_GRANT` runs on every
  revoke (CEO Q1, [[0054-applications-workflow-engine]] §6a).
- **The engine SA is pinned per run.** When the engine fires, the chosen `executedAsServiceAccount`
  is **copied onto** each [[workflow-run]] (`executedAsServiceAccountId`) so a run's principal stays
  fixed even if this binding changes later. Losing the SA (`SetNull`) never blocks deletion.

## Conventions

- **ID:** `cuid()` — a mutable config entity ([[0005-id-strategy]]). `applicationId` and
  `executedAsServiceAccountId` are also `cuid` ([[application]] / [[service-account]] use `cuid`).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt` (mutable domain config —
  edited, disabled and restorable; [[0006-soft-delete-and-auditing]] / [[0041-soft-delete-reuse-and-restore]]).

## Fields

Prisma model `ApplicationWorkflow` → table `application_workflows`. Validation schemas
(`ApplicationWorkflowSchema`, `CreateApplicationWorkflowSchema`, `UpdateApplicationWorkflowSchema`)
live in `@lazyit/shared` (`packages/shared/src/schemas/workflow.ts`, [[shared-package]]).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `applicationId` | `cuid` | FK → [[application]], required, `onDelete: Restrict`. |
| `trigger` | `WorkflowTrigger` | the firing event; create is limited to the v1 subset. |
| `name` | `string` | required admin label. |
| `description` | `string?` | optional. |
| `enabled` | `boolean` | `@default(false)` — inert until explicitly enabled. |
| `deprovisionPolicy` | `WorkflowDeprovisionPolicy` | `@default(LAST_ACTIVE_GRANT)`. |
| `executedAsServiceAccountId` | `cuid?` | FK → [[service-account]], `onDelete: SetNull`; the engine principal, pinned onto each run. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete ([[0006-soft-delete-and-auditing]]). |

Indexes: `@@index([applicationId])`, `@@index([executedAsServiceAccountId])`, plus the **partial
unique** `(applicationId, trigger) WHERE "deletedAt" IS NULL` (raw SQL).

`WorkflowTrigger` values: `ACCESS_GRANTED`, `ACCESS_REVOKED` (v1) · `TIMER_AFTER_GRANT`, `SCHEDULED`,
`RECERTIFICATION` (**reserved**, no behavior). `WorkflowDeprovisionPolicy` values: `LAST_ACTIVE_GRANT`
(default), `EACH_GRANT`.

## Endpoints

`apps/api/src/workflow-engine/definitions/` (`workflows.controller.ts`, in `WorkflowEngineModule`);
ADMIN-only in the seed ([[0046-roles-permissions-v2]]):

- `GET /workflows` · `GET /workflows/:id` — list / detail (detail includes `latestVersion`).
  `@RequirePermission('workflow:read')`.
- `POST /workflows` — create a binding (disabled by default). `@RequirePermission('workflow:manage')`.
- `PATCH /workflows/:id` — edit the mutable fields (trigger/app immutable). `workflow:manage`.
- `DELETE /workflows/:id` — soft delete. `workflow:manage`.
- `POST /workflows/:id/versions` — author a new immutable [[workflow-version]] (validates the step
  graph + connection refs). `workflow:manage`.

The firing side is `WorkflowTriggerService`, called **after commit** from `access-grants.service.ts`
(see [[workflow-run]] for the transactional-outbox / decoupling detail).

## Not yet implemented (deferred)

- The **timer triggers** (`TIMER_AFTER_GRANT` / `SCHEDULED` / `RECERTIFICATION`) are reserved enum
  slots for a later phase — re-certification is "**re-run the workflow + emit a report**", never an
  attestation / IGA subsystem ([[0054-applications-workflow-engine]] §6c).
- A `workflow:run` permission exists in the catalog but gates no route yet (reserved for a future
  manual re-run / dry-run affordance).

Related: [[workflow-connection]] · [[workflow-version]] · [[workflow-run]] · [[workflow-step-run]] ·
[[manual-task]] · [[workflow-secret]] · [[application]] · [[access-grant]] · [[service-account]] ·
[[shared-package]] · [[0054-applications-workflow-engine]] · [[0053-async-workers-bullmq-valkey]] ·
[[0048-service-accounts]] · [[0046-roles-permissions-v2]] · [[0023-access-management-design]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[INVARIANTS]]
