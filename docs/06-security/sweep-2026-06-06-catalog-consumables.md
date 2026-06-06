---
title: Sweep 2026-06-06 — applications / consumables catalog + stock movements
tags: [security, sweep]
status: draft
created: 2026-06-06
updated: 2026-06-06
---

# Sweep — catalog (applications) + consumables/stock-movements

Backend security sweep of the Access-catalog and Consumables pillars and their integration points.
Method: `.claude/skills/lazyit-sentinel/SKILL.md`. PoCs are **reasoned, not executed** (API not run).

## Scope

- `apps/api/src/applications` — application CRUD, `url`/href field (SEC-008 re-verify), nested
  access-grant + KB-article reads.
- `apps/api/src/application-categories` — category CRUD, soft-delete, delete semantics.
- `apps/api/src/consumables` — consumable CRUD, `currentStock`, FK to category.
- `apps/api/src/consumable-categories` — category CRUD, soft-delete, delete semantics.
- Consumable **stock-movement** flow (`POST /consumables/:id/movements`): IN/OUT/ADJUSTMENT, actor
  attribution (ADR-0048), quantity arithmetic, int4 bounds, concurrency.
- Shared schemas: `application.ts`, `consumable.ts`, `consumable-movement.ts`, `primitives.ts`.
- Cross-refs: ADR-0008/0023/0034/0036/0029, the soft-delete extension (ADR-0032), the Prisma exception
  filter, the `X-User-Id` shim, `@RequirePermission` gates.

## Findings

| ID | Sev | Module | One-line |
| --- | --- | --- | --- |
| [[SEC-050-consumable-soft-delete-bypass\|SEC-050]] | 🟠 Medium | consumables | `Consumable`/`ConsumableCategory` missing from `SOFT_DELETABLE_MODELS`; by-id reads + the category list leak archived rows, and IN/ADJUSTMENT movements + edits hit soft-deleted consumables |
| [[SEC-051-application-url-scheme-guard-port-carveout-bypass\|SEC-051]] | 🟠 Medium | applications | SEC-008 scheme guard bypassable: `javascript:1/alert(...)` passes the `host:port` carve-out (`^\d+(\/.*)?$`); JS division still fires the payload at a render sink |
| [[SEC-052-catalog-attach-to-soft-deleted-category\|SEC-052]] | 🟡 Low | applications / consumables | create/update accept a `categoryId` pointing at a SOFT-DELETED category (FK only checks existence; no live-parent guard) |

No Critical. SEC-051 (and SEC-050's write half) are the ones to prioritize.

## Verified clean (checked this sweep — a regression here would be a finding)

- **Stock movement races / lost update — CLEAN.** `OUT` uses a guarded `updateMany`
  (`where: { id, deletedAt: null, currentStock: { gte: quantity } }` + `decrement`) — an atomic
  check-and-act; a concurrent over-draw matches 0 rows → 409 + rollback. `IN` uses atomic `increment`,
  `ADJUSTMENT` an absolute set. No JS read-modify-write on the counter. `currentStock` cannot go
  negative. (`consumables.service.ts:204-280`.)
- **int4 overflow / underflow — CLEAN.** `quantity` is `int4({ min: 1 })` (1..2^31-1), so no negative
  or zero quantities and no body-supplied overflow. `IN` pre-checks `currentStock + quantity > INT4_MAX`
  → 409. Even the residual TOCTOU on that pre-check is safe: Postgres rejects an out-of-range int4 and
  `PrismaExceptionFilter` maps **P2020 → 400** (`prisma-exception.filter.ts:58-66`), never a wrap or a
  silent corruption. `quantity` bounded before the DB.
- **Actor attribution — CLEAN.** `performedById` / `serviceAccountId` come from the unified principal
  via `ActorService.resolveActor`, never the body; `CreateConsumableMovementSchema` is `strictObject`
  with no actor field. At-most-one-actor is CHECK-enforced (INV-SA-4). (`consumables.service.ts:209`,
  `:264-278`.)
- **Mass assignment — CLEAN.** All create/update bodies are `z.strictObject` (unknown keys rejected).
  `currentStock` is absent from `CreateConsumable`/`UpdateConsumable` — it only moves via movements.
  No server-owned field (`id`, `*At`, actor FKs) is body-settable.
- **SEC-008 core guard — STILL HOLDS for the documented vectors.** `isSafeApplicationUrl` still rejects
  `javascript:alert(...)`, case variants, embedded TAB/LF/CR, leading whitespace, a leading control
  byte, and `data:`/`vbscript:`/`file:`; applied symmetrically to create AND update. The ONLY gap is
  the `host:port` carve-out → SEC-051 (filed). `data:` stays blocked (its tail isn't digit-led).
- **AuthZ gates present — CLEAN.** Every route carries `@RequirePermission` (`*:read` / `*:write` /
  `*:delete`); writes are MEMBER+ADMIN, deletes/restore ADMIN, the archived `deleted=only` list slice
  is ADMIN-gated via `assertCanListDeleted`. No unannotated route in scope (matters for the
  fail-closed service-account path, INV-SA-2).
- **IDOR — N/A by model.** Applications/consumables/categories are single-org, team-wide resources with
  no per-user ownership, so a by-id read is not a cross-principal reference. (The real by-id issue is
  the soft-delete leak, SEC-050 — not ownership.)
- **Category delete semantics — CLEAN by design.** Both category deletes are soft-delete with
  `onDelete: SetNull`; deleting a category just detaches its children. No 409 in-use guard is needed
  (contrast ArticleCategory's required FK), matching ADR-0023/0034.
- **Injection — CLEAN.** All access is parameterized Prisma; no `$queryRaw`/`$executeRaw`, no
  `child_process`/`exec`/`eval`, no `fs` writes in scope. The `q` filter is a Prisma `contains` (not
  raw SQL). Movement `from`/`to` are `z.iso.datetime()` then `new Date()` — no string interpolation.
- **Movement query validation — CLEAN.** `ConsumableMovementQuerySchema` validates `type` against the
  enum and rejects an inverted `from`/`to` range (400).

## Integration risks / notes (not separately filed)

- **`GET /consumables/:id/movements` is unpaginated** — an append-only ledger with no `take`/`skip`.
  This is an instance of the already-open **SEC-007** (no pagination / unbounded list), not a new
  finding; it grows unbounded per consumable and should adopt the ADR-0030 `Page<T>` contract when
  movement volume warrants. Flagged here so SEC-007's scope includes it.
- **`metadata` jsonb on `Application`** is `z.record(z.string(), z.unknown())` — unvalidated, same
  accepted debt as DEF-004 (stored, not executed server-side; downstream web-sink risk). Not re-filed.
- **`X-User-Id` shim** remains the forgeable, dev-only identity baseline (DEF-002); the movement actor
  inherits that residual. Not a per-endpoint finding.
- **SEC-050 × SEC-052 compound on consumables:** because consumables aren't soft-delete-filtered
  (SEC-050), a supplied `categoryId` is doubly unguarded (SEC-052). Fixing SEC-050 (register the model)
  does not by itself add the live-parent write check — both need addressing.

## Range

Reserved SEC-050…SEC-059. Used **SEC-050, SEC-051, SEC-052**. Range not exhausted (7 free: SEC-053…SEC-059).
