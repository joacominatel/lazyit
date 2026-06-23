---
title: ImportSession
tags: [domain, entity, migrator, import, transient]
status: accepted
created: 2026-06-23
updated: 2026-06-23
---

# ImportSession

> 🟢 implemented (#627, promotion #649) · Area: Migrator · Transient, TTL-GC'd wizard session

## Purpose

The stateful, owner-scoped **wizard session** that drives a guided bulk import
([[0069-migrator-import]], phase 1: the [[asset]] slice). It threads the operator through the fixed
five-step shape — upload → parse → map → dry-run → commit — holding the confirmed mapping and the
frozen resolution plan between requests. Each row of the source file becomes a child [[import-row]];
each committed run is recorded in the append-only [[import-run]] ledger.

It is deliberately **transient**: the raw uploaded file is parsed once and discarded (no blob store,
no PII at rest beyond the coerced rows under TTL), and the session itself is hard-deleted by a GC
sweep 24h after upload. It carries no domain history of its own — the durable record of what an import
did lives in [[import-run]].

## Relationships

- **owned by** one [[user]] (`ownerId`, **required** FK → uuid `User`, `onDelete: Restrict`) — the
  human operator who started the import ([[0069-migrator-import]] §11). `Restrict` so an in-flight
  import is not orphaned by deleting its owner (the session is short-lived and GC-swept anyway).
- **has many** [[import-row]] (`rows`) — the per-row scratch, **`onDelete: Cascade`**: rows are
  reaped with the session.
- **correlates to** [[import-run]] — but there is **no `runs` back-relation and no FK**. The run
  ledger is append-only and must outlive session GC, so it references the session only via a durable
  plain `sessionId` string (see [[import-run]]). The session→run correlation is that retained value.

## Business rules

- **Transient — NOT soft-deletable.** Explicitly **excluded from `SOFT_DELETABLE_MODELS`**
  (`soft-delete.extension.ts`) so reads are not auto-scoped to `deletedAt: null` (the column doesn't
  exist). It is **hard-deleted** by a `setInterval` GC sweeper (`import-session-gc.sweeper.ts`,
  mirroring `NotificationsRetentionSweeper`) once `expiresAt` passes. A mid-commit (`COMMITTING`)
  session is **excluded** from the sweep ([[0069-migrator-import]] §2/§9).
- **Owner-scoped (no IDOR).** Every route resolves the session by id **and** owner; another user's
  session is never reachable ([[0069-migrator-import]] §11). The actor is always the principal's
  `user.id`, never a body/header field.
- **Human-only.** The import surface is guarded by `ServicePrincipalForbiddenGuard` — a service
  account is 403'd on every route regardless of grants, and `import:run` is in
  `SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS` ([[0069-migrator-import]] §11).
- **Status-gated transitions.** `status` walks the `ImportSessionStatus` enum
  (`PENDING → PARSING → PARSED → MAPPED → DRY_RUN → COMMITTING → COMMITTED`, plus `FAILED` / `EXPIRED`).
  Commit is rejected for a non-`DRY_RUN` (and non-resuming-`COMMITTING`) session; the enqueue uses a
  deterministic `jobId = sessionId` so a double-enqueue can't mint a second [[import-run]] or duplicate
  assets ([[0069-migrator-import]] wave-4a notes).
- **Raw file discarded.** Only the coerced [[import-row]]s persist (under TTL); the file bytes are
  parsed once in a sandboxed forked child and thrown away. `fileHash` retains the SHA-256 (never the
  contents) for audit/idempotency correlation.
- **PII-free at rest beyond the rows.** Session-level `error` and worker logs carry counts and
  conflict summaries only — never row PII ([[0069-migrator-import]] §11).

## Conventions

- **ID:** `cuid()` — operator-facing in the wizard URL ([[0005-id-strategy]]).
- **Timestamps:** `createdAt`, `updatedAt` (a session's `status` and blobs mutate across the wizard).
  **No `deletedAt`** — transient, hard-deleted by GC, not soft-deletable
  ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `ImportSession` → table `import_sessions`. The mapping / resolution-plan / detected
wire shapes are zod schemas in `@lazyit/shared` (`ImportMappingSchema`, `ImportResolutionPlanSchema`, …).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` — cuid() | PK — operator-facing in the wizard URL ([[0005-id-strategy]]). |
| `entity` | `ImportEntity` enum | What the import targets — `ASSET` is the only phase-1 member. Mirrors the `@lazyit/shared` `ImportEntitySchema`. |
| `status` | `ImportSessionStatus` enum | Lifecycle: `PENDING` / `PARSING` / `PARSED` / `MAPPED` / `DRY_RUN` / `COMMITTING` / `COMMITTED` / `FAILED` / `EXPIRED`. `@default(PENDING)`. |
| `ownerId` | `string` (`@db.Uuid`) | FK → `User.id`, `onDelete: Restrict`. The operator who started the import. |
| `mapping` | `Json?` | Confirmed column→field / value→enum / field→FK mapping blob (`ImportMappingSchema`). `null` until the map step. |
| `resolutionPlan` | `Json?` | Frozen per-conflict resolution plan (`ImportResolutionPlanSchema`), immutable once commit starts. `null` until dry-run. |
| `detected` | `Json?` | Source shape from the parse step: `{ headers, dialect, encoding, rowCount }`. `null` until `PARSED`; lets the map step render columns without re-reading the discarded file. |
| `error` | `Json?` | Whole-file failure detail when `status` is `FAILED` (PII-free). A *row*-level error lives on [[import-row]] `error`. |
| `fileHash` | `string?` | SHA-256 of the uploaded file (never its contents) for audit / idempotency correlation. |
| `expiresAt` | `datetime` | TTL horizon (24h from upload); the GC sweeper hard-deletes past this. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |

No `deletedAt` — transient, not soft-deletable. Indexed on `ownerId` (owner scoping) and `expiresAt`
(the GC age scan).

## Endpoints

`apps/api/src/import/` (`ImportModule`). All routes are owner-scoped, `import:run`-gated and
human-only (`ServicePrincipalForbiddenGuard`) — see [[0069-migrator-import]] §11 / wave-4b notes.

- `POST /imports` — multipart upload (multer size cap) → `202` + `sessionId`.
- `GET /imports/:id` — status + detected shape + rows.
- `POST /imports/:id/mapping` — confirm the mapping → `MAPPED`.
- `POST /imports/:id/dry-run` — full validate/coerce/resolve/conflict-detect pipeline, **writes
  nothing** → the per-row report + distinct-conflict set.
- `POST /imports/:id/plan` — freeze the resolution plan → `DRY_RUN`.
- `POST /imports/:id/commit` — enqueue the chunked commit (runtime per-target AND-check) → `202`.
- `GET /imports/:id/result` — the [[import-run]] ledger view.

Related: [[import-row]] · [[import-run]] · [[user]] · [[asset]] · [[0069-migrator-import]] ·
[[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] · [[0046-roles-permissions-v2]] ·
[[0053-async-workers-bullmq-valkey]]
