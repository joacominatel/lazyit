---
title: AiRun
tags: [domain, entity, ai-assistant]
status: accepted
created: 2026-09-23
updated: 2026-09-23
---

# AiRun

> 🟢 implemented (schema) · Area: AI assistant · see [[0097-ai-assistant-mcp-and-headless-api]] ·
> [[ai-assistant/_synthesis|synthesis]] §4.4, §6

## Purpose

One agent-loop execution — a chat turn or a headless prompt. A run is a BullMQ job that carries only
`{ runId }`; this row is its system of record: status, approval policy, step and token counts, the
redacted error. It holds **no content**.

## Business rules

- **Exactly one acting principal** — a [[user]] or a [[service-account]] (CHECK
  `ai_runs_exactly_one_principal`). Plain columns, not FKs: the row is a durable record.
- **Status** (text): `QUEUED → RUNNING → AWAITING_APPROVAL → … → SUCCEEDED | FAILED | CANCELLED |
  EXPIRED`. **Approval policy**: `REQUIRE_APPROVAL_FOR_WRITES` (humans) or `AUTONOMOUS` (service
  accounts).
- **Survives retention**: the conversation FK is `SetNull`, so budgets, usage and the ledger keep their
  reference after the transcript is gone.
- **Idempotency**: the headless `Idempotency-Key` is unique per principal — two partial unique indexes,
  `(userId, idempotencyKey)` and `(serviceAccountId, idempotencyKey)`, each `WHERE` both are non-null
  (raw SQL in the migration).
- A run is never retried blindly; a sweeper re-enqueues lost resumes and finalizes stale runs.

## Fields

Prisma model `AiRun` → table `ai_runs`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `conversationId` | `cuid?` | FK → [[ai-conversation]], `onDelete: SetNull`. |
| `channel` | `text` | `CHAT` \| `HEADLESS`. |
| `userId` / `serviceAccountId` | `uuid?` / `cuid?` | exactly one. |
| `status` / `approvalPolicy` | `text` | see above. |
| `provider` / `model` | `text` | |
| `stepCount` / `inputTokens` / `outputTokens` / `cachedInputTokens` | `int` | default 0. |
| `finishReason` | `text?` | |
| `error` | `json?` | redacted `{ code, message }`. |
| `idempotencyKey` | `text?` | partial unique per principal. |
| `cancelRequestedAt` / `startedAt` / `finishedAt` | `datetime?` | |
| `createdAt` / `updatedAt` | `datetime` | mutable lifecycle row (the [[manual-task]] precedent). |

## AiUsage

Prisma model `AiUsage` → table `ai_usage`. One row per model step: principal, provider, model and the
input / output / cached / reasoning token counts. `bigint` autoincrement, **append-only and kept** — it
feeds the per-principal daily budget and the usage view. No content, no FKs.

Related: [[ai-conversation]] · [[ai-tool-invocation]] · [[ai-action-log]] · [[ai-settings]]
