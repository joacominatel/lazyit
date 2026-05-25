---
title: Application
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Application

> 🟢 implemented · Area: Access · Implementation order: 5

## Purpose

Something a [[user]] can be granted access to: a SaaS product (Jira, GitHub, AWS), an internal
system, or a technical service (VPN, AD group). The catalog of "things you can hold access on" —
the access-management pillar of lazyit ([[problem-space]]). See [[0023-access-management-design]].

## Relationships

- **grouped by** an optional [[application-category]] (`categoryId`, optional FK,
  `onDelete: SetNull` — deleting a category detaches its applications, like
  [[asset-model]] → [[asset-category]]).
- **granted via** N [[access-grant]]s (to [[user]]s).

## Business rules

- Only `name` is required. `description`, `url`, `vendor`, `notes` are optional free text.
- **`url` is stored as a plain string, not strictly URL-validated** — internal IT targets are often
  scheme-less hosts (e.g. `vpn.corp.local`) that a strict validator would reject.
- **`isCritical`** (default `false`) flags an application whose access is especially sensitive
  (production infra, finance). Informational for now; the UI can highlight it.
- **Category is optional and `SetNull`** — an application with no category is valid, and deleting a
  category never deletes its applications.
- Soft delete ([[0006-soft-delete-and-auditing]]); reads filter `deletedAt: null`.

> [!note] Prior design discarded — no `type` enum, no approvers
> An earlier draft of this note gave `Application` a hardcoded `type` enum and per-application
> **approvers**. Both were dropped ([[0023-access-management-design]]): classification is a
> user-managed [[application-category]] (consistent with assets/articles), and approver logic
> belongs to the [[access-request]] workflow, which is **deferred**.

> [!warning] Auth is a temporary shim — endpoints are insecure
> There is **no authorization** on application or grant writes yet — anyone can create/edit/delete
> applications and grant/revoke access. The actor on grants is just an `X-User-Id` header anyone can
> set. Dev-only until an IdP lands ([[0016-auth-strategy-deferred]],
> [[0022-draft-visibility-auth-shim]], [[0023-access-management-design]]).

> [!warning] Known debt — unvalidated `metadata`
> `metadata` (jsonb) accepts **any JSON object** (`z.record(z.string(), z.unknown())`), exactly like
> `Asset.specs` ([[0007-flexible-asset-specs-jsonb]]). Typed per-use validation is deferred.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields

Prisma model `Application` → table `applications`. Validation schemas (`ApplicationSchema`,
`CreateApplicationSchema`, `UpdateApplicationSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/application.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `name` | `string` | required (≤200). |
| `description` | `string?` | optional (≤2000). |
| `url` | `string?` | optional system URL; stored as a free string (not strictly URL-validated). |
| `vendor` | `string?` | optional provider (Atlassian, Microsoft, AWS, …). |
| `categoryId` | `cuid?` | optional FK → [[application-category]], `onDelete: SetNull`. |
| `isCritical` | `boolean` | `@default(false)`. |
| `metadata` | `jsonb?` | free-form extras; any JSON object for now (see debt note). |
| `notes` | `string?` | optional free text. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete. |

Indexes: `@@index([categoryId])`.

## Endpoints

`apps/api/src/applications/` (`ApplicationsModule`). Documented via Swagger
([[0018-api-documentation-swagger]]).

- `GET /applications` — list (excludes soft-deleted, ordered by name).
- `GET /applications/:id` — one by id (`404` if missing/soft-deleted).
- `GET /applications/:id/access-grants?activeOnly=&includeExpired=` — this app's grants
  ([[access-grant]]); `404` if the app is missing.
- `POST /applications` — create.
- `PATCH /applications/:id` — partial update.
- `DELETE /applications/:id` — soft delete.

## Not yet implemented (deferred)

- [[access-request]] (approval workflow + approvers) — explicitly deferred
  ([[0023-access-management-design]]).
- `metadata` validation; a soft-delete-time guard for apps that still have active grants.

Related: [[application-category]] · [[access-grant]] · [[access-request]] · [[user]] ·
[[shared-package]] · [[0023-access-management-design]] · [[0016-auth-strategy-deferred]] ·
[[0007-flexible-asset-specs-jsonb]] · [[0006-soft-delete-and-auditing]] ·
[[0018-api-documentation-swagger]]
