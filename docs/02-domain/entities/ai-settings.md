---
title: AiSettings
tags: [domain, entity, ai-assistant, config, security]
status: accepted
created: 2026-09-23
updated: 2026-09-23
---

# AiSettings

> 🟢 implemented (schema) · Area: AI assistant · see [[0097-ai-assistant-mcp-and-headless-api]] ·
> [[ai-assistant/_synthesis|synthesis]] §6

## Purpose

The instance-wide AI configuration: whether the chat is on, which provider and model it uses, the
encrypted provider key, the limits and budgets, the conversation retention, and the independent MCP
switch. It is **off by default** and an admin enables it through the Settings → AI wizard.

## Business rules

- **Singleton.** One row, id `singleton`, pinned by the `ai_settings_singleton` CHECK (the
  SMTP-settings precedent, [[0079-instance-smtp-outbound-email]]). An **absent row reads as the disabled
  default**, so an instance that never enables AI behaves exactly as before.
- **`settings:manage` only**, human sessions only. A service account can never configure AI
  (`settings:manage` is SA-ungrantable).
- **The key is write-only** (INV-AI-6). It is stored as an AES-256-GCM envelope
  (`apiKeyCiphertext` / `apiKeyIv` / `apiKeyAuthTag` / `apiKeyKeyVersion`) under its own optional key
  axis `AI_SECRET_KEY`; the read shape exposes only `apiKeySet`. Changing `provider` or `baseUrl` clears
  it (destination binding).
- **Enabling** needs a passing connection test (`verifiedAt`) and the acknowledged egress disclosure
  (`disclosureAcknowledgedAt`, also recorded in [[ai-config-audit-log]]).
- **`mcpEnabled` is independent** of the provider: MCP works without an LLM (CEO, round 2).
- **The MCP client allowlist is an overlay** ([[0097-ai-assistant-mcp-and-headless-api]] decision 13).
  The curated defaults (the usual clients) live in code; this row stores only the admin's own entries
  (`mcpClientAllowlistAdded`) and the ids of the defaults the admin removed
  (`mcpClientAllowlistRemovedDefaults`), so a later release can correct a default's identifier without
  undoing the admin's choices. Entries match on a CIMD URL or a redirect-URI pattern, never on
  `client_name`. `mcpAllowAnyHttpsClient` (off by default) accepts any client whose redirect URIs are
  HTTPS and non-loopback, with a warning on the consent screen.
- **Text columns, validated on write.** `provider` and `effort` are text checked by the zod vocabularies
  in `@lazyit/shared` (`ai-provider.ts`), so a newer value degrades to "not configured" on an older build.
- Mutable config: `createdAt` + `updatedAt`, **no `deletedAt`**.

## Fields

Prisma model `AiSettings` → table `ai_settings`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `text` | always `singleton` (CHECK). |
| `enabled` | `bool` | default `false` — the chat and headless switch. |
| `provider` / `model` / `baseUrl` | `text?` | `anthropic` \| `openai` \| `google` \| `openai-compatible`; `baseUrl` for the OpenAI-compatible provider. |
| `apiKeyCiphertext` / `apiKeyIv` / `apiKeyAuthTag` / `apiKeyKeyVersion` | `text?` / `int?` | the key envelope; all null when no key is stored. Never on the wire. |
| `allowPrivateNetwork` | `bool` | default `false`; OpenAI-compatible only, scoped to the base URL's host (INV-AI-7). |
| `effort` | `text?` | `low` \| `medium` \| `high`; null = provider default. |
| `providerOptions` | `json?` | per-provider extras (the OpenAI-compatible `temperature`). |
| `instructions` | `text?` | admin addendum to the frozen system prompt (≤ 4000). |
| `maxStepsPerRun` / `maxOutputTokens` / `contextTokenLimit` | `int` | defaults 20 / 16000 / 150000. |
| `dailyTokenLimitPerPrincipal` | `int?` | default 2 000 000; null = no budget. |
| `retentionDays` | `int` | default 90 (zod 7–3650) — conversation retention. |
| `approvalTtlMinutes` | `int` | default 30 — how long a chat approval stays open. |
| `mcpEnabled` | `bool` | default `false` — the MCP switch. |
| `mcpClientAllowlistAdded` | `json` | default `[]` — the admin's own allowlist entries. |
| `mcpClientAllowlistRemovedDefaults` | `text[]` | default `{}` — the ids of the curated defaults the admin removed. |
| `mcpAllowAnyHttpsClient` | `bool` | default `false` — accept any HTTPS (non-loopback) client, with a consent warning. |
| `disclosureAcknowledgedAt` / `disclosureAcknowledgedById` | `datetime?` / `uuid?` | the egress-disclosure acknowledgement. |
| `verifiedAt` | `datetime?` | last passing connection test of the current connection fields. |
| `updatedById` | `uuid?` | FK → [[user]], `onDelete: SetNull`. |
| `createdAt` / `updatedAt` | `datetime` | `updatedAt` is the status endpoint's `configRevision`. |

Related: [[ai-service-account-settings]] · [[ai-config-audit-log]] · [[ai-conversation]] ·
[[0097-ai-assistant-mcp-and-headless-api]] · [[0079-instance-smtp-outbound-email]]
