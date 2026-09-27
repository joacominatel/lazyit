---
title: AiConfigAuditLog
tags: [domain, entity, ai-assistant, audit]
status: accepted
created: 2026-09-23
updated: 2026-09-24
---

# AiConfigAuditLog

> 🟢 implemented (schema + the settings writer, W2-2) · Area: AI assistant · see [[0097-ai-assistant-mcp-and-headless-api]] ·
> [[ai-assistant/_synthesis|synthesis]] §8.2

## Purpose

An **append-only** trail of AI configuration changes: edits to [[ai-settings]] (redacted — never the
key), changes to a service account's [[ai-service-account-settings]], and the egress-disclosure
acknowledgement that enabling AI requires ([[ai-assistant/security|security]] §6.4–6.5).

## Business rules

- Append-only and immutable ([[0006-soft-delete-and-auditing]]).
- The actor is always a human admin — the configuration routes are human-only.
- `detail` is redacted before it is written: no key, no ciphertext.
- The `action` vocabulary is owned by the settings module (`AI_CONFIG_AUDIT_ACTIONS`,
  `apps/api/src/ai/settings/ai-settings.constants.ts`). As built (W2-2):
  - `settings.updated` — one row per `PUT /config/ai` that changed anything; `detail.changes` maps each
    changed field to `{ before, after }`. `baseUrl` is recorded without credentials, query or fragment;
    `instructions` as lengths only; the MCP allowlist overlay as `{ added: entries, removed: ids }`; the
    key only as what happened to it (`apiKey: "set" | "cleared" | "cleared-destination-changed"`). A
    no-op save writes nothing.
  - `disclosure.acknowledged` — the egress disclosure, once; the row's actor is its author and `detail`
    names the provider and the redacted base URL it was acknowledged for.
  - The per-SA actions arrive with the headless unit.
- The settings row and its audit rows are written in one transaction; a refused save writes neither.

## Fields

Prisma model `AiConfigAuditLog` → table `ai_config_audit_log`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | autoincrement ([[0005-id-strategy]]). |
| `action` | `text` | what changed. |
| `actorId` | `uuid?` | FK → [[user]], `onDelete: SetNull`. |
| `targetServiceAccountId` | `text?` | the SA whose AI access changed. |
| `detail` | `json?` | redacted before/after. |
| `createdAt` | `datetime` | |

Related: [[ai-settings]] · [[ai-service-account-settings]] · [[permission-audit-log]]
