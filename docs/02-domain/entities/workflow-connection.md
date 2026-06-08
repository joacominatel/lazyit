---
title: WorkflowConnection
tags: [domain, entity, workflow-engine, access, security]
status: accepted
created: 2026-06-08
updated: 2026-06-08
---

# WorkflowConnection

> 🟢 implemented · Area: Access / Workflow engine (epic #248) · see [[0054-applications-workflow-engine]]

## Purpose

The **per-application connector instance** — *how* the workflow engine reaches an external system.
One connection holds the non-secret integration settings (base URL, auth scheme, header names) and a
**reference** to the credential, and is reused by the application's grant + revoke workflows. A `kind`
discriminator selects the connector ([[0054-applications-workflow-engine]] §7); the variable settings
live in a zod-validated jsonb `config` ([[0007-flexible-asset-specs-jsonb]]).

**v1 ships `REST` + `WEBHOOK_OUT` + `MANUAL`** — the declarative, zero-code-per-app tier covering the
Jira worked example (create on grant, deactivate on revoke, "which team?" as a manual step). `SDK` /
`MCP` / `PREBUILT` / `CUSTOM` are **reserved enum slots with no handler** (the connectors registry
*throws* rather than silently no-op'ing a reserved kind — code-backed tiers ship *in the image*, never
runtime-loaded).

## Relationships

- **belongs to** one [[application]] (`applicationId`, **required** FK, `onDelete: Restrict`).
- **authenticates with** an optional [[workflow-secret]] (`secretId`, `onDelete: SetNull`, named
  relation `ConnectionCredential`) — a **reference** to the engine's encrypted store, **never** the
  secret itself. Losing the secret row surfaces as "no credential configured", not a deleted
  connection; **rotation = point `secretId` at a new (or re-encrypted) [[workflow-secret]]**.
- **scopes** N [[workflow-secret]]s (`scopedSecrets`, named relation `SecretConnectionScope`) — the
  inverse of `WorkflowSecret.connectionId`: secrets provisioned *for* this connection (a secret may
  also be app-level, with a null `connectionId`).

> [!note] Two distinct connection ↔ secret relations (bidirectional)
> A `WorkflowConnection` both **uses** a credential (`secretId` → `ConnectionCredential`) and **scopes**
> credentials (`scopedSecrets` ← `SecretConnectionScope`). These are deliberately separate named
> relations: the first is "the credential I authenticate with", the second is "secrets bound to me".
> The bidirectionality is flagged for CTO review in [[0054-applications-workflow-engine]] (Consequences).

## Business rules

- **Credentials are NEVER inlined.** `config` carries non-secret settings only (base URL, auth
  *scheme*, header names, default headers) — never a cleartext credential. The credential is a
  `secretId` reference into [[workflow-secret]] (INV-6, [[INVARIANTS]]). A REST config's `authScheme`
  says only *how* to attach the separately-stored credential at call time (`NONE` / `BEARER` / `BASIC`
  / `HEADER`).
- **`config` is validated per `kind`.** A zod **discriminated union** on `kind`
  (`WorkflowConnectionConfigSchema`) validates the jsonb at the edge; on create, `config.kind` **must
  equal** the connection `kind` (a refine returns `400` otherwise). No per-kind tables
  ([[0007-flexible-asset-specs-jsonb]] discipline).
- **Egress = public destinations only.** REST `baseUrl` and WEBHOOK_OUT `url` must be **public
  `https` URLs** (`publicHttpsUrl`); a non-https / non-URL value is a clean `400` at the edge. The
  runtime egress guard (scheme allowlist, deny resolved private/loopback/link-local/metadata IPs, pin
  the resolved IP, re-validate redirects) is the real defense at call time. On-prem / internal targets
  are a near-term roadmap item, **not** v1 ([[0054-applications-workflow-engine]] §6b).
- **MANUAL has no endpoint.** A `MANUAL` connection makes no external call (`ManualConnectionConfig`
  is just `{ kind }`); a human performs the step via the [[manual-task]] inbox.

## Conventions

- **ID:** `cuid()` — a mutable config entity ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`
  ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `WorkflowConnection` → table `workflow_connections`. Validation schemas
(`WorkflowConnectionSchema`, `CreateWorkflowConnectionSchema`, the per-kind config union
`WorkflowConnectionConfigSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/workflow.ts`, [[shared-package]]).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `applicationId` | `cuid` | FK → [[application]], required, `onDelete: Restrict`. |
| `kind` | `WorkflowConnectionKind` | the connector discriminator; create limited to the v1 subset. |
| `name` | `string` | required admin label. |
| `config` | `jsonb` | non-secret, zod-validated-per-kind connection settings. **Never** a credential. |
| `secretId` | `cuid?` | FK → [[workflow-secret]] (`ConnectionCredential`), `onDelete: SetNull`. The credential reference; `null` = no credential configured. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete. |

Indexes: `@@index([applicationId])`, `@@index([secretId])`.

`WorkflowConnectionKind` values: `REST`, `WEBHOOK_OUT`, `MANUAL` (v1) · `SDK`, `MCP`, `PREBUILT`,
`CUSTOM` (**reserved**, no handler). The read shape exposes `secretId` as a nullable descriptor —
"whether a credential is configured", **never** the secret.

## Endpoints

`apps/api/src/workflow-engine/definitions/` (`workflow-connections.controller.ts`); ADMIN-only in the
seed ([[0046-roles-permissions-v2]]):

- `GET /workflow-connections` · `GET /workflow-connections/:id` — list / detail.
  `@RequirePermission('workflow:read')`.
- `POST /workflow-connections` — create (`config.kind` must match `kind`). `workflow:manage`.
- `PATCH /workflow-connections/:id` — edit. `workflow:manage`.
- `DELETE /workflow-connections/:id` — soft delete. `workflow:manage`.

The REST / WEBHOOK_OUT call paths are the step handlers (`handlers/rest.handler.ts`,
`handlers/webhook-out.handler.ts`, `handlers/outbound-http.ts`), reached during a [[workflow-run]].

## Not yet implemented (deferred)

- The **reserved connector kinds** (`SDK` / `MCP` / `PREBUILT` / `CUSTOM`) have no handler — the
  registry throws if a run reaches one ([[0054-applications-workflow-engine]] §7).
- **On-prem / internal-target connectors** via an explicit per-connector allowlist — a real near-term
  priority for the on-prem-heavy market, but **not** v1.
- **Inbound `webhook_in`** (HMAC + replay + single-use token) for async external callbacks is a later
  phase.

Related: [[application-workflow]] · [[workflow-version]] · [[workflow-run]] · [[workflow-secret]] ·
[[manual-task]] · [[application]] · [[shared-package]] · [[0054-applications-workflow-engine]] ·
[[0007-flexible-asset-specs-jsonb]] · [[0048-service-accounts]] · [[0046-roles-permissions-v2]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[INVARIANTS]]
