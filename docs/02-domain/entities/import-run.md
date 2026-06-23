---
title: ImportRun
tags: [domain, entity, migrator, import, audit, append-only]
status: accepted
created: 2026-06-23
updated: 2026-06-23
---

# ImportRun

> 🟢 implemented (#627, promotion #649) · Area: Migrator · Append-only commit ledger

## Purpose

The **append-only audit ledger** of a guided bulk-import commit ([[0069-migrator-import]] §9). One row
records *who* committed *what* and *when* — the actor, the target entity, the final counts, the
distinct-conflict summary, and the file **hash** (never its contents), for audit and a future undo
correlation id. It is the **durable record of what an import did**: unlike the transient
[[import-session]] / [[import-row]] scratch, an `ImportRun` is never deleted.

It is written **once, after the commit loop, with final counts** (true append-only — never
inserted-zeroed-then-updated), so a mid-batch worker throw never leaves stale counts
([[0069-migrator-import]] wave-4a notes).

## Relationships

- **correlates to** an [[import-session]] via `sessionId` — a **durable plain `String` column,
  deliberately NOT an FK**. The session is transient (24h TTL, GC-hard-deleted) but this ledger must
  **survive** that deletion ([[0006-soft-delete-and-auditing]] — an append-only ledger is never
  deleted). A cascading FK would let the session GC reap the audit-of-record, so the correlation is
  kept as a **retained value**, not a relation. The migration `…_import_run_ledger_survives_session_gc`
  drops the original `import_runs_sessionId_fkey` for exactly this reason. Consequently there is **no
  back-relation** on [[import-session]].
- **run by** an optional [[user]] (`actorId`, FK → uuid `User`, **`onDelete: SetNull`**) — the actor
  who ran the commit. `SetNull` so the ledger survives the actor's deletion (`actorId = null` = deleted
  user / system).
- **correlates to** the created [[asset]]s indirectly: each imported asset's `CREATED` [[asset-history]]
  event carries `{ source: 'import', sessionId, rowIndex }` provenance ([[0069-migrator-import]] §8/§9),
  so the asset→import link rides that stable `sessionId` value (not the autoincrement run id, which is
  unknown until after the loop).

## Business rules

- **Append-only ([[0006-soft-delete-and-auditing]]).** Rows are only ever `INSERT`ed — never `UPDATE`d,
  never deleted. `autoincrement` id, `createdAt` ONLY — no `updatedAt`, no `deletedAt`. **NOT in
  `SOFT_DELETABLE_MODELS`.**
- **Outlives session GC.** The GC sweeper (`import-session-gc.sweeper.ts`) deletes only the
  [[import-session]] (cascading to its [[import-row]]s) — **never `ImportRun`**. Because `sessionId` is a
  plain retained column, the ledger keeps a valid record of the run after its session is reaped.
- **Written once with final counts.** The single insert happens after the commit loop completes, so the
  recorded `counts` / `conflictSummary` are always final and consistent.
- **Idempotent enqueue.** The commit enqueue uses a deterministic `jobId = sessionId`, so a
  double-enqueue can't mint a second `ImportRun` or duplicate assets ([[0069-migrator-import]] wave-4a).
- **Metadata only.** Records counts, the conflict summary and the file hash — never the file contents or
  row PII ([[0069-migrator-import]] §11).

## Conventions

- **ID:** `autoincrement()` — a ledger table, never exposed externally ([[0005-id-strategy]]).
- **Append-only:** `createdAt` only — no `updatedAt`, no `deletedAt` ([[0006-soft-delete-and-auditing]]).
- **No FK on `sessionId`** — a durable retained string so the ledger survives session GC. Same posture
  as the soft-target columns on [[secret-audit-log]] (the audit row must outlive the referenced entity).

## Fields

Prisma model `ImportRun` → table `import_runs`. The counts / conflict-summary wire shapes are zod
schemas in `@lazyit/shared` (`ImportCountsSchema`, `ImportResolutionPlanSchema`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `Int` — autoincrement() | PK — a ledger table, never exposed externally ([[0005-id-strategy]]). |
| `sessionId` | `string` | **Durable plain column, NOT an FK** — retained so the ledger outlives the transient [[import-session]]'s GC. |
| `entity` | `ImportEntity` enum | What the import targeted — `ASSET` in phase 1. |
| `actorId` | `string?` (`@db.Uuid`) | FK → `User.id`, `onDelete: SetNull`. `null` if the actor was later deleted. |
| `counts` | `Json` | Final per-outcome counts (`ImportCountsSchema`): created / matched / restored / failed …. |
| `conflictSummary` | `Json?` | Distinct-conflict summary (`ImportResolutionPlanSchema`). `null` when no conflicts. |
| `fileHash` | `string?` | SHA-256 of the imported file (never its contents) for audit / undo correlation. |
| `createdAt` | `datetime` | Event timestamp. Append-only: no `updatedAt`, no `deletedAt`. |

No `updatedAt` / `deletedAt` — append-only ledger. Indexed on `(sessionId, id)` (the per-session run
timeline) and `actorId`.

Related: [[import-session]] · [[import-row]] · [[user]] · [[asset]] · [[asset-history]] ·
[[secret-audit-log]] · [[0069-migrator-import]] · [[0005-id-strategy]] ·
[[0006-soft-delete-and-auditing]]
