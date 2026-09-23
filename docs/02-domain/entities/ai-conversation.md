---
title: AiConversation
tags: [domain, entity, ai-assistant, retention]
status: accepted
created: 2026-09-23
updated: 2026-09-23
---

# AiConversation

> 🟢 implemented (schema) · Area: AI assistant · see [[0097-ai-assistant-mcp-and-headless-api]] ·
> [[ai-assistant/_synthesis|synthesis]] §6

## Purpose

A chat thread (`CHAT`) or a headless session (`HEADLESS`) and its ordered messages. It is a **transcript
container, not a system of record**: what the AI changed lives in the domain history tables and in the
permanent [[ai-action-log]].

## Business rules

- **Exactly one owner** — a [[user]] or a [[service-account]] (CHECK
  `ai_conversations_exactly_one_owner`). **Owner-only**: anyone else, admins included, gets 404.
- **Hard-deleted, deliberately** ([[0097-ai-assistant-mcp-and-headless-api]] decision 11, the
  [[0056-in-app-notification-bell]] §7 precedent): by the retention sweep after `retentionDays` of
  inactivity, by its owner, and on offboarding. The exception to "never hard-delete" is scoped to
  transcripts; the ledgers are never pruned.
- **Pinned** at creation to its provider, model, prompt version and tool set. A change makes it
  read-only (`closedReason` = `CONFIG_CHANGED` / `VERSION_CHANGED`); crossing the context cap closes it
  with `CONTEXT_LIMIT`.
- **One active run** at a time (409 `RUN_IN_PROGRESS`, enforced by the runtime).
- MCP keeps **no** server-side conversation.

## Fields

Prisma model `AiConversation` → table `ai_conversations`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | [[0005-id-strategy]]. |
| `channel` | `text` | `CHAT` \| `HEADLESS`. |
| `userId` / `serviceAccountId` | `uuid?` / `cuid?` | the owner — exactly one; FK `onDelete: Cascade`. |
| `title` | `text?` | |
| `provider` / `model` / `promptVersion` / `toolsetHash` / `toolNames` | | pinned at creation. |
| `closedReason` | `text?` | null while writable. |
| `lastActivityAt` | `datetime` | drives retention. |
| `createdAt` / `updatedAt` | `datetime` | no `deletedAt` (hard-deleted). |

## AiMessage

Prisma model `AiMessage` → table `ai_messages`. One ordered, **provider-replayable** message.
Append-only; it cascades with its conversation.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `bigint` | autoincrement ([[0005-id-strategy]]). |
| `conversationId` | `cuid` | FK → conversation, `onDelete: Cascade`. |
| `runId` | `cuid?` | FK → [[ai-run]], `onDelete: SetNull`. |
| `seq` | `int` | unique per conversation. |
| `role` | `text` | `user` \| `assistant` \| `tool`. |
| `content` | `json` | the exact provider message; projected to a neutral wire shape before it leaves the API. |
| `format` | `text` | default `aisdk-v7` — the converter a future SDK major needs. |
| `createdAt` | `datetime` | |

Related: [[ai-run]] · [[ai-tool-invocation]] · [[ai-action-log]] · [[ai-settings]]
