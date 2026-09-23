---
title: AiActionLog
tags: [domain, entity, ai-assistant, audit]
status: accepted
created: 2026-09-23
updated: 2026-09-23
---

# AiActionLog

> 🟢 implemented (schema) · Area: AI assistant · see [[0097-ai-assistant-mcp-and-headless-api]]
> decision 11 · [[ai-assistant/_synthesis|synthesis]] §6, INV-AI-10

## Purpose

The **single, permanent, append-only ledger of AI-initiated mutations** on every channel (R6). One row
per write lifecycle event: who acted, through which channel and client, which tool with which redacted
input, how it was approved, and the outcome. It is what an operator reads to answer "what did the AI
change, for whom, and who approved it".

## Business rules

- **Append-only at the database.** The `ai_action_log_append_only` trigger rejects every `DELETE` and
  every `UPDATE` — except the actor foreign keys' own `ON DELETE SET NULL`, which only nulls
  `userId` / `serviceAccountId`. A buggy or compromised application path cannot rewrite or erase it.
  `TRUNCATE` is not covered: the threat is the application, not a database administrator.
- **Never pruned**, and self-contained: conversation, run, invocation, MCP client and grant ids are
  plain strings, so the row outlives transcript retention.
- **At most one actor** — a [[user]] or a [[service-account]] (CHECK `ai_action_log_one_actor`,
  [[INVARIANTS]] INV-SA-4). The actor is the real principal; the AI never has an identity of its own.
- **Events** (text): `PROPOSED`, `APPROVED`, `REJECTED`, `EXPIRED`, `CANCELLED`, `ATTEMPTED`,
  `EXECUTED`, `FAILED`, `DENIED`. The chat writes `PROPOSED` → decision → outcome; MCP and headless
  write `ATTEMPTED` → outcome.
- **Reads are not here** — they live in the retention-bound [[ai-tool-invocation]].
- The input is **redacted**; no secret is ever recorded.

## Fields

Prisma model `AiActionLog` → table `ai_action_log`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | autoincrement ([[0005-id-strategy]]). |
| `invocationId` | `text` | the [[ai-tool-invocation]] id (also on the domain history row). |
| `event` / `channel` | `text` | see above. |
| `toolName` / `toolClass` | `text` | |
| `userId` / `serviceAccountId` | `uuid?` / `cuid?` | FKs, `onDelete: SetNull`; at most one. |
| `conversationId` / `runId` / `mcpClientId` / `oauthGrantId` | `text?` | plain strings. |
| `input` / `entityRefs` | `json?` | redacted canonical input; entity refs. |
| `approverUserId` / `stepUp` | `uuid?` / `bool` | approval provenance (chat). |
| `untrustedSources` | `json?` | other-authored content the turn had read. |
| `provider` / `model` / `requestId` | `text?` | |
| `errorCode` / `errorStatus` / `errorMessage` | | |
| `createdAt` | `datetime` | append-only ([[0006-soft-delete-and-auditing]]). |

Related: [[ai-tool-invocation]] · [[asset-history]] · [[user-history]] ·
[[0097-ai-assistant-mcp-and-headless-api]] · [[0006-soft-delete-and-auditing]]
