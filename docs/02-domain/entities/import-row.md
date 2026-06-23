---
title: ImportRow
tags: [domain, entity, migrator, import, transient]
status: accepted
created: 2026-06-23
updated: 2026-06-23
---

# ImportRow

> 🟢 implemented (#627, promotion #649) · Area: Migrator · Transient per-row scratch

## Purpose

One parsed-and-coerced **source row** of a guided bulk import ([[0069-migrator-import]], phase 1: the
[[asset]] slice). The parse step (a sandboxed forked child) normalizes every record of the uploaded
file into an `ImportRow`; the dry-run and commit steps read these rows back. It holds both the raw
parsed source values and the coercion pre-pass output that feeds the **unchanged** `CreateAssetSchema`,
plus the row's evolving status and any field-level error.

It is **transient scratch**: there can be thousands per [[import-session]], it is never exposed
externally, and it is hard-deleted with its session.

## Relationships

- **belongs to** one [[import-session]] (`sessionId`, **required** FK, **`onDelete: Cascade`**) — a row
  is reaped when its session is GC-deleted. This is the only FK on the model.
- Indirectly feeds [[import-run]] (the commit loop tallies COMMITTED rows into the ledger counts), but
  there is no direct relation.

## Business rules

- **Transient — NOT soft-deletable.** Explicitly **excluded from `SOFT_DELETABLE_MODELS`** (the
  `deletedAt` column doesn't exist) and **hard-deleted with its session** via the FK cascade when the
  GC sweeper reaps the [[import-session]] ([[0069-migrator-import]] §2/§9).
- **Coercion single-sourced.** `raw` is the parsed source values (column → string); `coerced` is the
  pre-pass output (field → coerced value) that feeds the **unchanged** `CreateAssetSchema` — never a
  looser import schema, so soft-delete / uniqueness / normalization invariants can't drift. The same
  coercion runs in the web preview and the API commit, so the preview can't lie
  ([[0069-migrator-import]] §3).
- **Status mutates across the wizard.** `status` walks `ImportRowStatus`
  (`PENDING → COERCED → VALID`/`INVALID → COMMITTED`/`FAILED` …) — hence the model carries `updatedAt`
  (unlike a pure append-only table).
- **`rowIndex` is the stable key.** The 0-based source index the row-keyed result schema keys on; it
  survives re-ordering and powers resume (a re-run skips `COMMITTED` rows, keep-partial —
  [[0069-migrator-import]] §8).
- **PII-free logs.** Field-level `error` detail is recorded on the row, but logs carry counts /
  conflict summaries only ([[0069-migrator-import]] §11).

## Conventions

- **ID:** `autoincrement()` — thousands per session, never exposed externally ([[0005-id-strategy]]).
- **Timestamps:** `createdAt`, `updatedAt` (the row's `status` mutates across the wizard). **No
  `deletedAt`** — transient, hard-deleted with its session ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `ImportRow` → table `import_rows`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `Int` — autoincrement() | PK — never exposed externally ([[0005-id-strategy]]). |
| `sessionId` | `string` | FK → `ImportSession.id`, `onDelete: Cascade` — reaped with its session. |
| `rowIndex` | `Int` | Stable 0-based source index the row-keyed result schema keys on. |
| `status` | `ImportRowStatus` enum | `PENDING` → `COERCED` → `VALID`/`INVALID` → `COMMITTED`/`FAILED` …. `@default(PENDING)`. |
| `raw` | `Json` | Parsed source values (column → string). |
| `coerced` | `Json?` | Coercion-pre-pass output (field → coerced value) that feeds `CreateAssetSchema`. `null` until coerced. |
| `error` | `Json?` | Field-level / row error detail when `status` is `INVALID`/`FAILED` (PII-free in logs). |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |

No `deletedAt` — transient, not soft-deletable. Indexed on `(sessionId, rowIndex)` and
`(sessionId, status)` (the per-session ordered scan and the status-filtered resume scan).

Related: [[import-session]] · [[import-run]] · [[user]] · [[asset]] · [[0069-migrator-import]] ·
[[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] · [[0007-flexible-asset-specs-jsonb]]
