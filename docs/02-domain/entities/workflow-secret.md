---
title: WorkflowSecret
tags: [domain, entity, workflow-engine, access, security, secrets]
status: accepted
created: 2026-06-08
updated: 2026-06-08
---

# WorkflowSecret

> 🟢 implemented · Area: Access / Workflow engine (epic #248) · see [[0054-applications-workflow-engine]]

## Purpose

The engine's **OWN encrypted credential store** — the per-application secret a [[workflow-connection]]
authenticates with (a Jira API token, a webhook signing secret, …). The engine deliberately brings its
own **AES-256-GCM** store rather than coupling to the Settings `SystemSecret` store: **one key axis per
subsystem**, governed by the engine's own RBAC (`workflow:secrets`, separation of duties from
`workflow:manage`) and lifecycle ([[0054-applications-workflow-engine]] §5). It is the
[[service-account]] `tokenPrefix` pattern applied to integration credentials — the cleartext is shown
to no one after it is set.

## Relationships

- **belongs to** one [[application]] (`applicationId`, **required** FK, `onDelete: Restrict` — a
  secret's app can't be hard-deleted).
- **optionally scoped to** one [[workflow-connection]] (`connectionId`, `onDelete: SetNull`, named
  relation `SecretConnectionScope`) — the connection it was provisioned for; `null` = an app-level
  secret not yet bound to a specific connection. On create with a `connectionId`, the service also
  points that connection's `secretId` **at** this secret.
- **is used by** N [[workflow-connection]]s (`connectionsUsing`, named relation `ConnectionCredential`)
  — the inverse of `WorkflowConnection.secretId`: connections currently authenticating with this
  secret as their credential.

## Business rules

- **Write-only on the API.** Create / rotate accept a **cleartext `value`** (≤ 8192 chars) that is
  encrypted server-side and **never persisted in cleartext, never returned, never logged**. Every read
  returns the **redacted descriptor** — `configured: true`, `label`, `keyVersion`, timestamps — and
  **never** the ciphertext / IV / auth tag / cleartext (INV-6, [[INVARIANTS]],
  [[0054-applications-workflow-engine]] §5).
- **The ciphertext columns are never on a wire shape.** `ciphertext` / `iv` / `authTag` exist only at
  rest; `WorkflowSecretSchema` (the read shape) carries none of them — only the redacted descriptor
  (INV-6). This is the structural reason a secret can't leak through a read, dry-run, test or audit.
- **AES-256-GCM envelope.** Each value stores its `ciphertext` + a per-value random `iv` + the GCM
  `authTag` + the `keyVersion`. `keyVersion` supports **key rotation without re-reading plaintext**.
- **`WORKFLOW_SECRET_KEY` is the boot linchpin.** The 32-byte master key lives in the
  `WORKFLOW_SECRET_KEY` env var (`apps/api/.env.example`); the `SecretService` has a **fail-loud
  `onModuleInit`** — the API **refuses to boot** without a valid key ("a half-configured secret store
  is worse than an absent one"). The encryption itself lives in `workflow-engine/secrets/secret.service.ts`.
- **Rotation in place or by replacement.** `PATCH /workflow-secrets/:id` re-encrypts a live secret's
  value (a new IV/tag, same row). Alternatively, create a new secret and **point the connection at it**
  ([[workflow-connection]] rotation); the old one soft-deletes.

## Conventions

- **ID:** `cuid()` — a mutable config entity ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt` (mutable domain config,
  [[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `WorkflowSecret` → table `workflow_secrets`. Validation schemas (the **redacted**
`WorkflowSecretSchema`, the write-only `CreateWorkflowSecretSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/workflow.ts`, [[shared-package]]); **no** schema carries the ciphertext or
cleartext.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `applicationId` | `cuid` | FK → [[application]], required, `onDelete: Restrict`. |
| `connectionId` | `cuid?` | FK → [[workflow-connection]] (`SecretConnectionScope`), `onDelete: SetNull`; `null` = app-level. |
| `label` | `string` | human-recognizable, **non-secret** label (e.g. "Jira API token"). |
| `ciphertext` | `string` | AES-256-GCM ciphertext (at-rest only; **never** on a wire shape). |
| `iv` | `string` | per-value random initialization vector (at-rest only). |
| `authTag` | `string` | GCM auth tag (at-rest only). |
| `keyVersion` | `int` | `@default(1)`; which key produced the envelope (supports rotation). |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete. |

Indexes: `@@index([applicationId])`, `@@index([connectionId])`. The read descriptor exposes
`configured: true` + `label` + `keyVersion` — never the envelope.

## Endpoints

`apps/api/src/workflow-engine/definitions/` (`workflow-secrets.controller.ts`); ADMIN-only in the seed,
**writes gated on `workflow:secrets`** (separation of duties from `workflow:manage`,
[[0046-roles-permissions-v2]]):

- `GET /workflow-secrets` · `GET /workflow-secrets/:id` — list / detail (**redacted descriptors only**).
  `@RequirePermission('workflow:read')`.
- `POST /workflow-secrets` — create + encrypt the cleartext `value` (if connection-scoped, also points
  the connection at it). `workflow:secrets`.
- `PATCH /workflow-secrets/:id` — rotate (re-encrypt the value in place). `workflow:secrets`.
- `DELETE /workflow-secrets/:id` — soft delete. `workflow:secrets`.

## Not yet implemented (deferred)

- **Envelope / KMS-style key management** beyond the single `WORKFLOW_SECRET_KEY` + `keyVersion`
  (e.g. an external KMS, automated rotation) is a future hardening item.
- OAuth2-with-refresh credential flows (vs a static token) are a near-term connector extension, not v1
  ([[0054-applications-workflow-engine]]).

Related: [[workflow-connection]] · [[application-workflow]] · [[workflow-run]] · [[service-account]] ·
[[application]] · [[shared-package]] · [[0054-applications-workflow-engine]] · [[0048-service-accounts]] ·
[[0046-roles-permissions-v2]] · [[0031-logging-strategy]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
