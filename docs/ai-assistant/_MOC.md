---
title: "AI Assistant — Map of Content"
tags: [ai-assistant, moc, index, mcp, oauth, llm]
status: draft
created: 2026-09-23
updated: 2026-09-23
---

# AI Assistant — Map of Content

> Design vault for lazyit's **opt-in AI capability** (epic #1315): an in-app navbar chat that controls
> the app live, an **MCP server** for external agents (Claude Code, Cursor, claude.ai), and a
> **headless API** where a Service Account sends a prompt from a server. All three channels share one
> tool catalog, and the AI always acts as the invoking principal with exactly its permissions. Off by
> default.
>
> **Start here:** read [[ai-assistant/_synthesis|the synthesis]] first — it is the binding
> architecture; the five area notes below are its depth. The decision record is
> [[0097-ai-assistant-mcp-and-headless-api|ADR-0097]] (accepted).

## The synthesis (read first)

- [[ai-assistant/_synthesis|_synthesis]] — the three channels, the CEO's decisions (verbatim), the
  cross-slice reconciliations R1–R10, the reconciled contracts, one directory tree, the consolidated
  data model, the proposed INV-AI invariants, the defaults adopted pending review, and the unified
  implementation plan in waves.

## Area designs

- [[ai-assistant/mcp-and-oauth|MCP server and OAuth 2.1]] — the stateless MCP endpoint on the official
  SDK v2; lazyit as its own OAuth 2.1 authorization server on the local session (DCR + CIMD, opaque
  audience-bound tokens, scopes `lazyit.read` / `write` / `admin`); personal tokens on `lan`; the
  instance-served Claude Code plugin; the client × deployment matrix.
- [[ai-assistant/provider-and-runtime|Provider layer and runtime]] — the `ChatModelPort` over AI SDK 7
  and how to add a provider; lazyit's own agent loop as BullMQ jobs with Postgres as the system of
  record; the approval state machine; the SSE run-event stream; `AiSettings` and its enable/disable
  lifecycle; budgets, observability and infrastructure impact.
- [[ai-assistant/tools-and-execution|Tools and execution]] — the one tool catalog (the 44-tool v1 cut and
  the domain inventory); in-process execution through Nest's own pipeline with a delegated identity; the
  descriptor and its classes; the confirmation contract; `AiActionLog` and history provenance; the
  domain primer.
- [[ai-assistant/frontend|Frontend]] — the non-modal chat panel in the app shell and its reactive-UI
  contract; the Settings → AI wizard; `/account/ai` for install and connected apps; the OAuth consent
  page; the i18n and Manual plan.
- [[ai-assistant/security|Security and threat model]] — trust boundaries, the STRIDE table per channel,
  prompt injection and the lethal trifecta, the elevated confirmation tier, provider egress and key
  custody, the invariants, the test plan, and the review gates G1–G4.

## Key referenced decisions

- [[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[0080-service-account-secret-retrieval]]
  — the permission catalog and the Service Account principal the design extends.
- [[0086-local-authentication-mode]] · [[0087-plain-http-lan-deployment-axis]] — the local session the
  authorization server builds on, and the plain-HTTP `lan` axis that shapes MCP.
- [[0053-async-workers-bullmq-valkey]] · [[0054-applications-workflow-engine]] — the durable-run pattern
  the agent runtime reuses.
- [[0079-instance-smtp-outbound-email]] · [[0061-secret-manager-zero-knowledge]] ·
  [[0056-in-app-notification-bell]] · [[0096-jest-commonjs-against-esm-nestjs]].
