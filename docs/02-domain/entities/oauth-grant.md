---
title: OAuthGrant
tags: [domain, entity, ai-assistant, mcp, oauth, security]
status: accepted
created: 2026-09-23
updated: 2026-09-24
---

# OAuthGrant

> 🟢 implemented (schema + authorization server, W2-4) · Area: AI assistant — MCP · see [[0097-ai-assistant-mcp-and-headless-api]]
> decisions 8–9 · [[ai-assistant/mcp-and-oauth|MCP]] §5–6

## Purpose

A **connected app**: one user's delegation to one [[oauth-client]], or a personal MCP token on a
plain-HTTP `lan` instance. It is what the user sees and revokes under "Connected apps", and what every
`/mcp` request is checked against.

## Business rules

- **Soft delete = revoked** ([[0006-soft-delete-and-auditing]], [[0032-soft-delete-middleware]]).
  `revokeReason`: `user` \| `admin` \| `refresh_reuse` \| `revocation_endpoint` \| `client_deleted`.
  The model is in `SOFT_DELETABLE_MODELS` (the soft-delete extension), so reads hide revoked grants;
  relation reads (a token's `grant`) check `deletedAt` explicitly. Revoking hard-deletes the grant's
  token rows in the same transaction and writes `GRANT_REVOKED` (or `PERSONAL_TOKEN_REVOKED`).
- **Who revokes**: the owner (`user`), an admin holding `settings:manage` (`admin`), refresh-token reuse
  (`refresh_reuse`), or the client through RFC 7009 (`revocation_endpoint`).
- **Scopes are exactly what the user ticked** at consent (a subset of the request); a refresh never
  changes them. The scope hierarchy (`write` ⊇ `read`) is applied when tools are listed.
- **Dies with the user's MCP-credential epoch**: `mcpCredentialEpoch` is a snapshot of
  [[user]]`.mcpCredentialEpoch`; a password change or reset, an admin reset or *revoke sessions*, the
  recovery CLI, a deactivation or an offboarding bumps it and every grant stops working (and leaves the
  connected-apps lists). **A normal web logout does not**: it bumps only `sessionEpoch`, so the grant
  survives it ([[0097-ai-assistant-mcp-and-headless-api]] decision 8, amended 2026-09-24). Deactivation,
  `directoryOnly` and `mustChangePassword` also refuse it.
- **Authority** = the user's current permissions ∩ the scope class (`lazyit.read` → `read` tools,
  `lazyit.write` → `write`, `lazyit.admin` → `elevated`), re-checked on every call with `ai:connect` and
  the MCP switch.
- `kind` `personal` (`lzit_pat_…`) exists only on `lan`, always with an expiry (90 days by default,
  365 at most).

## Fields

Prisma model `OAuthGrant` → table `oauth_grants`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `userId` | `uuid` | FK → [[user]], `onDelete: Cascade`. |
| `kind` | `text` | `oauth` \| `personal`. |
| `clientRefId` | `cuid?` | FK → [[oauth-client]], `onDelete: SetNull`; null for personal tokens. |
| `label` | `text?` | the personal token's name. |
| `scopes` | `text[]` | subset of `lazyit.read` / `lazyit.write` / `lazyit.admin`. |
| `resource` | `text` | the canonical MCP URI at issuance (RFC 8707). |
| `sessionEpoch` | `int` | the user's `sessionEpoch` at issuance — informational only since 2026-09-24. |
| `mcpCredentialEpoch` | `int` | the user's `mcpCredentialEpoch` at issuance; a mismatch means dead. Grants that predate the column were set to 0 when alive and -1 (never matches) when already dead. |
| `expiresAt` / `lastUsedAt` | `datetime?` | expiry is mandatory for personal tokens. |
| `revokeReason` / `revokedById` | `text?` / `uuid?` | |
| `createdAt` / `updatedAt` / `deletedAt` | `datetime` | soft delete = revoked. |

## Credential rows (hard-deleted)

Both store **only a SHA-256 hash** and are credential material, not domain data — the sweeper
hard-deletes them (the `PasswordResetToken` precedent).

- **`OAuthAuthorizationCode`** → `oauth_authorization_codes`: single use, 60 s, bound to the user,
  client, redirect, PKCE challenge, scopes and resource. FK → [[oauth-client]] (`Cascade`).
- **`OAuthToken`** → `oauth_tokens`: `kind` `access` (`lzit_oat_`, 1 h) \| `refresh` (`lzit_ort_`,
  30 days from last use, rotated on every use — reuse outside a 30 s grace window revokes the grant) \|
  `personal` (`lzit_pat_`). FK → grant (`Cascade`). Accepted only on `/mcp`.

## OAuthAuditLog

Prisma model `OAuthAuditLog` → table `oauth_audit_log`. The append-only security trail of the
authorization server (ADR-0081 source `oauth`): client registered, grant created, consent denied, grant
revoked, refresh reuse detected, personal token created or revoked. Plain ids, so rows outlive the
clients, grants and users they mention. Never records a secret.

Related: [[oauth-client]] · [[user]] · [[ai-tool-invocation]] · [[0097-ai-assistant-mcp-and-headless-api]]
