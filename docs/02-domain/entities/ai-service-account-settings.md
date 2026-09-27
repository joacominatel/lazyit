---
title: AiServiceAccountSettings
tags: [domain, entity, ai-assistant, service-accounts]
status: accepted
created: 2026-09-23
updated: 2026-09-23
---

# AiServiceAccountSettings

> 🟢 implemented (schema) · Area: AI assistant · see [[0097-ai-assistant-mcp-and-headless-api]]
> decision 4 · [[ai-assistant/_synthesis|synthesis]] §2 decision 13

## Purpose

A [[service-account]]'s AI access for **headless** runs, set on the service account's page: `off`,
`read-only` or `read-write`, plus an optional cap on executed writes per run. It narrows what the SA's
own grants already allow — it never widens them.

## Business rules

- **An absent row reads as `read-write`** (the CEO's "autónomo total, pero configurable"), so no row is
  created for an SA until an admin changes the setting.
- `read-only` limits the SA to `read`-class tools; `off` refuses every run.
- The SA still needs `ai:use`; an SA holding `infra:report` cannot be given AI access (enforced by the
  API).
- Its own table, so `service_accounts` gains no column. Mutable config, no `deletedAt`. Changes are
  audited in [[ai-config-audit-log]].

## Fields

Prisma model `AiServiceAccountSettings` → table `ai_service_account_settings`.

| Field | Type | Notes |
| --- | --- | --- |
| `serviceAccountId` | `cuid` | PK and FK → [[service-account]], `onDelete: Cascade`. |
| `access` | `text` | `off` \| `read-only` \| `read-write`; default `read-write`. |
| `maxMutationsPerRun` | `int?` | null = no cap beyond the step limit. Counts **changes**, not calls: a batch tool counts its rows, and a call that would pass the cap is refused whole (SEC-081). Headless: per run; MCP: per rolling hour. |
| `createdAt` / `updatedAt` | `datetime` | |

Related: [[service-account]] · [[ai-settings]] · [[ai-config-audit-log]]
