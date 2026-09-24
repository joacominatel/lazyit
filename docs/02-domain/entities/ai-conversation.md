---
title: AiConversation
tags: [domain, entity, ai-assistant, retention]
status: accepted
created: 2026-09-23
updated: 2026-09-24
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
  - **As built (W3-6)**: `AiConversationPurgeService` (`apps/api/src/ai/retention/`) is the only deleter.
    An hourly pass deletes conversations whose `lastActivityAt` is older than `retentionDays` (clamped
    to 7–3650 on read, so a hand-set value above 3650 reads as 3650) and every conversation of an offboarded user (`User.deletedAt` set — only that; a deactivation or a directory soft-offboard, `isActive = false` + `directoryOffboardedAt`, follows normal retention, CEO decision 2026-09-24), in batches of
    100 with at most 20 batches per reason per pass. A conversation with a `QUEUED`, `RUNNING`,
    `AWAITING_APPROVAL` or `AWAITING_INPUT` run, or an `AWAITING_APPROVAL`, `AWAITING_INPUT` or `EXECUTING` tool invocation, is **never** deleted: the pass skips it and retries next hour; an owner's
    delete answers 409 `RUN_IN_PROGRESS`. Each batch locks its rows and re-checks runs and the guard
    before deleting, so a run cannot start in a conversation being deleted.
  - The pass runs whether or not the assistant is enabled (turning AI off keeps conversations dormant;
    retention keeps running).
- **Pinned** at creation to its provider, model, prompt version and tool set. A change makes it
  read-only (`closedReason` = `CONFIG_CHANGED` / `VERSION_CHANGED`); crossing the context cap closes it
  with `CONTEXT_LIMIT`.
  - **Model per conversation** (#1373, ADR-0097 decision 5 as amended 2026-09-24): the owner may choose
    the model (any model of the configured provider, listed or custom), a reasoning effort and provider
    options — at creation or until the first run starts; then they are pinned. A conversation on the
    admin's default (`modelChosen = false`) is still closed by a change of the default model; one whose
    model was chosen is not. A provider change closes both.
- **Auto-approve** (#1376, ADR-0097 decision 4 as amended 2026-09-24): off by default; its owner may switch
  it on or off at any time (audited). While on, ordinary chat writes (not elevated, no step-up warning,
  not in a turn that read other-authored content) run without a card, recorded in the [[ai-action-log]] with `approvalMode = AUTO`.
- **Web search** (#1389, ADR-0097 decision 3 as amended 2026-09-24): a chat conversation started while
  [[ai-settings]] `webSearchEnabled` is on, on a provider and model that support it, is frozen with the
  search cap (`webSearchMaxUses`) and may use the provider's own web search; its tool list then never
  changes. Turning the setting off makes it read-only (`CONFIG_CHANGED`). Headless conversations never
  search. A step that searched stores a `lazyit-web-search-v1` record (search count, reported queries,
  `http(s)` sources) after its assistant message: the web shows the sources under the answer.
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
| `provider` / `model` / `promptVersion` / `toolsetHash` / `toolNames` | | pinned at creation (the model changeable until the first run). |
| `modelChosen` | `bool` | default `false`; `true` when the owner chose `model` (#1373). |
| `effort` / `providerOptions` | `text?` / `json?` | the owner's reasoning effort and provider options; null = the instance setting. Validated on write, read tolerantly. |
| `autoApprove` / `autoApproveEnabledAt` | `bool` / `datetime?` | auto-approve mode (#1376), default off; when it was last switched on. |
| `webSearchMaxUses` | `int?` | the web search cap the conversation was frozen with (#1389); null = no web search (every legacy and headless row). |
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
| `format` | `text` | default `aisdk-v7` — the converter a future SDK major needs. Runtime records (never sent to the model) use `lazyit-*` formats, e.g. `lazyit-web-search-v1` (#1389). |
| `createdAt` | `datetime` | |

Related: [[ai-run]] · [[ai-tool-invocation]] · [[ai-action-log]] · [[ai-settings]]
