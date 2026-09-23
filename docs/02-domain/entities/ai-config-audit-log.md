---
title: AiConfigAuditLog
tags: [domain, entity, ai-assistant, audit]
status: accepted
created: 2026-09-23
updated: 2026-09-23
---

# AiConfigAuditLog

> 🟢 implemented (schema) · Area: AI assistant · see [[0097-ai-assistant-mcp-and-headless-api]] ·
> [[ai-assistant/_synthesis|synthesis]] §8.2

## Purpose

An **append-only** trail of AI configuration changes: edits to [[ai-settings]] (redacted — never the
key), changes to a service account's [[ai-service-account-settings]], and the egress-disclosure
acknowledgement that enabling AI requires ([[ai-assistant/security|security]] §6.4–6.5).

## Business rules

- Append-only and immutable ([[0006-soft-delete-and-auditing]]).
- The actor is always a human admin — the configuration routes are human-only.
- `detail` is redacted before it is written: no key, no ciphertext.
- The `action` vocabulary is owned by the settings module.

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
