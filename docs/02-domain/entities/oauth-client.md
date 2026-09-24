---
title: OAuthClient
tags: [domain, entity, ai-assistant, mcp, oauth, security]
status: accepted
created: 2026-09-23
updated: 2026-09-24
---

# OAuthClient

> 🟢 implemented (schema + DCR, W2-4) · Area: AI assistant — MCP · see [[0097-ai-assistant-mcp-and-headless-api]]
> decision 8 · [[ai-assistant/mcp-and-oauth|MCP]] §6

## Purpose

A client of lazyit's own OAuth 2.1 authorization server — an external agent such as Claude Code or
Cursor that connects over MCP. It is registered dynamically (DCR), known through a fetched Client ID
Metadata Document (CIMD), or bundled with lazyit.

## Business rules

- **Public clients only** (PKCE S256, no client secret).
- `kind` (text): `dcr` \| `cimd` \| `known`. A DCR client's name is **self-declared**; a CIMD client is
  identified by its https `client_id` URL, fetched through the egress guard.
- **Redirects match exactly**, except loopback addresses, where only the port is ignored.
- Protocol state, not domain data: unused DCR clients without grants are **hard-deleted** after 24 h.
- Which clients may connect is the admin-configurable allowlist of
  [[0097-ai-assistant-mcp-and-headless-api]] decision 13, matched on the CIMD URL or a redirect-URI
  pattern, never on `name`. **Every** registered redirect must be admitted, and the
  check is repeated at consent, code exchange and refresh. The curated defaults live in
  `apps/api/src/oauth/client-allowlist.defaults.ts` ([[ai-assistant/mcp-and-oauth|MCP]] §12).
- A DCR `name` is stripped of control and bidi characters and capped at 120 characters; `logoUri` is
  not accepted from a registration; `clientUri` is kept only when it is https.
- `lastUsedAt` is stamped at the first code exchange, which is what keeps a used registration from
  the 24 h garbage collection.

## Fields

Prisma model `OAuthClient` → table `oauth_clients`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `clientId` | `text` | unique; `lzc_…` for DCR, the https document URL for CIMD. |
| `kind` | `text` | `dcr` \| `cimd` \| `known`. |
| `name` / `clientUri` / `logoUri` | `text` | display metadata. |
| `redirectUris` | `text[]` | |
| `metadata` | `json` | the sanitized registration or CIMD document. |
| `fetchedAt` / `lastUsedAt` | `datetime?` | CIMD freshness; last use. |
| `createdAt` / `updatedAt` | `datetime` | |

Related: [[oauth-grant]] · [[0097-ai-assistant-mcp-and-headless-api]]
