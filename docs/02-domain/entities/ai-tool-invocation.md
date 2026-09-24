---
title: AiToolInvocation
tags: [domain, entity, ai-assistant, retention]
status: accepted
created: 2026-09-23
updated: 2026-09-24
---

# AiToolInvocation

> 🟢 implemented (schema; written by the AI core for writes and chat proposals) · Area: AI assistant · see [[0097-ai-assistant-mcp-and-headless-api]] ·
> [[ai-assistant/_synthesis|synthesis]] §4.2–4.4, §6

## Purpose

Every tool call on every channel. For an interactive chat write it **is the pending action**: the
stored canonical input, the server-built preview, the precondition and the expiry the user approves.
For MCP and headless calls it is the **metadata access log**. Its id is the `invocationId` stamped on
[[asset-history]] and [[user-history]] (`aiInvocationId`) and recorded in [[ai-action-log]].

## Business rules

- **At most one actor** — a [[user]] or a [[service-account]] (CHECK `ai_tool_invocations_one_actor`).
- **Status** (text): reads and autonomous writes `EXECUTING → SUCCEEDED | FAILED | DENIED`; interactive
  writes `AWAITING_APPROVAL → REJECTED | EXPIRED | CANCELLED`, or the atomic approve claim
  `AWAITING_APPROVAL → EXECUTING → SUCCEEDED | FAILED | OUTCOME_UNKNOWN`. `OUTCOME_UNKNOWN` is never
  retried. An **input request** (#1388, `request_input`, chat only): `AWAITING_INPUT → SUCCEEDED`
  (submitted) `| REJECTED` (skipped or declined) `| EXPIRED | CANCELLED`; its `preview` holds `{ kind:
  "input_request", form, answer? }` (the stored form the answer is validated against, and the user's
  answer as given once submitted), its `result` the answer as the model receives it (lazyit text wrapped
  as untrusted). Written by the runtime (`AiInputRequests`), not a write: no
  [[ai-action-log]] event.
- **What was approved is exactly what runs**: `inputHash` binds the approval to the stored input,
  `schemaHash` expires it if the tool changed, and `precondition` (`{ entity, updatedAt }`) fails a stale
  target with `STALE`.
- **Written by the AI core** (`AiToolService`, [[ai-assistant/tools-and-execution|tools]] §8.4, §9):
  every MCP or headless write (`EXECUTING` → outcome) and every chat proposal (`AWAITING_APPROVAL` →
  decision). Its transitions are atomic conditional updates on `status`, so an approval executes once.
  Reads are not written here yet (the MCP/headless metadata access log belongs to the channel units).
- **Retention-bound**: cascades with its conversation; conversation-less (MCP) rows are pruned after
  `retentionDays` by the hourly retention pass — except a row still `AWAITING_APPROVAL`,
  `AWAITING_INPUT` or `EXECUTING`, which waits until it settles. The permanent record of a write is [[ai-action-log]].

## Fields

Prisma model `AiToolInvocation` → table `ai_tool_invocations`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | the `invocationId`. |
| `channel` | `text` | `CHAT` \| `MCP` \| `HEADLESS`. |
| `conversationId` | `cuid?` | FK → [[ai-conversation]], `onDelete: Cascade`. |
| `runId` | `cuid?` | plain reference to [[ai-run]]. |
| `toolUseId` | `text?` | the provider's tool-use block id. |
| `toolName` / `toolClass` | `text` | class `read` \| `write` \| `elevated` \| `navigate`. |
| `userId` / `serviceAccountId` | `uuid?` / `cuid?` | at most one. |
| `mcpClientId` / `oauthGrantId` | `text?` | MCP provenance. |
| `input` / `inputHash` / `schemaHash` | `json` / `text` | canonical input and its bindings. |
| `status` | `text` | see above. |
| `preview` / `precondition` | `json?` | the server-built preview. |
| `expiresAt` / `decidedAt` | `datetime?` | |
| `result` / `entityRefs` | `json?` | the tool result as written (truncated once). |
| `errorCode` | `text?` | |
| `durationMs` | `int?` | |
| `approvalMode` | `text?` | `USER` \| `AUTO` once a chat write is approved (auto-approve mode, #1376); null otherwise. |
| `createdAt` / `updatedAt` | `datetime` | |

Related: [[ai-action-log]] · [[ai-run]] · [[ai-conversation]] · [[oauth-grant]]
