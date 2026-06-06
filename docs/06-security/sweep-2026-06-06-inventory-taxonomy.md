---
title: Sweep 2026-06-06 — inventory taxonomy (asset-categories, asset-models, locations)
tags: [security, sweep]
status: draft
created: 2026-06-06
---

# Sweep 2026-06-06 — inventory taxonomy

Deep audit of the three taxonomy/inventory-reference modules and their integration with the rest of
the API. Method: `.claude/skills/lazyit-sentinel/SKILL.md`. The API was **not run** — all PoCs are
reasoned from code.

## Scope

- `apps/api/src/asset-categories` — category CRUD, soft-delete, uniqueness, restore.
- `apps/api/src/asset-models` — model CRUD, `specs` jsonb, FK to category, paged list, restore.
- `apps/api/src/locations` — location CRUD, `LocationType` enum, paged list, restore.
- Shared schemas: `packages/shared/src/schemas/{asset-category,asset-model,location,primitives}.ts`.
- Integration surfaces touched: `assets.service.ts` (eager includes of model/category/location),
  the Prisma soft-delete `$extends` extension, the `common/` query parsers + deleted-slice gate.
- ADRs cross-referenced: 0006, 0017, 0032, 0036, 0041 (+ 0030 pagination, 0007 jsonb).

## Findings

| ID | Severity | Class | One-line |
| --- | --- | --- | --- |
| [[SEC-040-soft-deleted-parent-leaks-via-asset-includes\|SEC-040]] | 🟡 Low | soft-delete bypass / info-leak | Soft-deleted location/model/category still returned to any `asset:read` caller via the asset relation includes (nested reads aren't filtered — ADR-0032 caveat now triggered). |
| [[SEC-041-soft-delete-no-child-reconciliation-dangling-fk\|SEC-041]] | 🟡 Low | soft-delete bypass / data-integrity | Soft-deleting a category/model/location neither refuses nor detaches its children; the `SetNull` detach only fires on a hard delete, leaving live children pointing at an invisible parent (and children can be created against a soft-deleted parent). |

No Critical/High/Medium findings in scope. Range used: **SEC-040, SEC-041** (SEC-042..SEC-049 still
free — range not exhausted).

Both findings share one root cause — soft delete (an `UPDATE`) doesn't reconcile FK references the
way the schema's `SetNull`/`Restrict` intents imply, and the soft-delete read filter doesn't reach
nested relations. SEC-041 (the dangling FK) is what makes SEC-040 (the leak) reachable; fixing
SEC-041 by detaching-on-delete also closes SEC-040.

## Verified clean (checked this sweep — a regression here would be a finding)

- **Mass assignment.** All create/update schemas are `z.strictObject` (unknown keys rejected) and
  carry no server-owned fields (`id`, `*At`, `deletedAt`). Empty PATCH bodies rejected
  (`requireAtLeastOneKey`). `asset-category.ts`, `asset-model.ts`, `location.ts`.
- **`LocationType` enum bypass.** `type` is validated by `LocationTypeSchema` (`z.enum`) on both
  create and update, surfaced through `createZodDto` + the global `ZodValidationPipe`. An
  out-of-enum value is a clean 400; no raw string reaches the Prisma enum column.
- **AuthZ on every route.** Reads gated `*:read`, writes `*:write`, delete/restore `*:delete`
  (ADMIN by seed). The privileged `deleted=only` list slice is ADMIN-gated at the controller
  (`assertCanListDeleted` → 403) for models and locations.
- **IDOR.** These are org-wide reference entities with no per-user ownership; any `*:read` principal
  is meant to see all rows. No object-level ownership check is applicable or missing.
- **Uniqueness / soft-delete interplay (resurrection).** `create()` carries no pre-check and relies
  solely on the partial unique index `WHERE deletedAt IS NULL` (P2002 → 409) — the race-safe pattern
  (ADR-0041), not a TOCTOU bug. A soft-deleted name/sku is reusable **by design**. A soft-deleted row
  cannot be edited (`update()` → `findOne()` 404s it); only `restore()` revives it, and `restore()`
  can legitimately 409 if the freed value was retaken. No way to resurrect/edit via the normal write
  path.
- **Restore.** Uses the sanctioned `includeSoftDeleted` escape hatch, 404s a never-existing id, is
  idempotent when already live. No authZ gap (`*:delete` / ADMIN).
- **Query-param injection / 500s.** `categoryId` is cuid-validated (`parseCuidQuery` → 400, SEC-004
  class closed); pagination (`limit/offset/page/dir/deleted`) validated (`parsePageQuery` → 400);
  `sort` is allowlisted per resource (`resolveSortOrBadRequest` → 400 on unknown field). No
  `$queryRaw`/`$executeRaw`, no `child_process`/`eval`/`fs` writes in scope.
- **Location hierarchy / self-or-cycle parent refs — NOT APPLICABLE.** `Location` is **flat**: the
  schema has no `parentId`/self-relation (`schema.prisma:277-293`, explicitly "Flat
  (non-hierarchical) for now"). The cycle/self-parent attack surface the brief anticipated does not
  exist. If a hierarchy is added later, re-audit for self-reference and cycle creation.

## Module-specific notes (not separately filed)

- **SEC-007 (unbounded list) — module case:** `GET /asset-categories` (`findAll`) returns
  `findMany` with no pagination (`asset-categories.service.ts:11-15`), unlike `/asset-models` and
  `/locations`, which are paged (ADR-0030). This is the already-filed transversal SEC-007 class, not
  re-reported; noted here as the one taxonomy list still on the raw-array contract.
- **`q` substring search** uses `contains` + `mode: 'insensitive'` (leading-wildcard ILIKE) with no
  length cap on `q` and no index help, so each search is a full scan. Result size is bounded by
  pagination (models/locations), so impact is marginal; rolls into the SEC-007 / DoS posture, not a
  new finding.
- **`AssetModel.specs` jsonb is unvalidated** (`z.record(z.string(), z.unknown())`) — accepted debt
  DEF-004 (ADR-0007), bounded by Express's ~100 kB body limit, stored-not-executed server-side. No
  new finding; the downstream (frontend) render sink remains the place to watch.

## Integration risks (cross-module)

- **assets ⇄ taxonomy (the main one).** Assets eagerly include `model.category` + `location`
  (`ASSET_RELATIONS`, `ASSET_LIST_SELECT`); combined with the soft-delete model that doesn't
  reconcile children, this is SEC-040 + SEC-041. Any change to how taxonomy parents are deleted must
  account for the asset include and the `?categoryId=`/`?locationId=` filters.
- **search (Meili, ADR-0035).** Locations are indexed/de-indexed on create/update/delete/restore.
  `remove()` correctly drops the soft-deleted location from the index, so search does **not** leak it
  (unlike the asset include). asset-categories/asset-models are not indexed. No finding.
- **consumables / applications** also use `SetNull` category FKs (`ConsumableCategory`,
  `ApplicationCategory`) with the same bare-soft-delete `remove()` shape — i.e. SEC-041's class is
  almost certainly **transversal** beyond the three audited modules. Out of this sweep's scope, but
  flagged for the next pass: whatever semantics are chosen for SEC-041 should be applied uniformly to
  every soft-deletable parent with `SetNull` children.

## Coverage / gaps

- **Covered:** all three modules' controllers + services end-to-end, shared validation schemas, the
  soft-delete extension behavior for top-level vs nested reads, the query parsers and deleted-slice
  gate, and the asset-include integration. Cross-checked against ADR-0006/0017/0032/0036/0041.
- **Reasoned, not exercised:** the partial-unique-index race backstop and the nested-include
  filtering are inferred from code + ADR text (no DB/API run). The `nestjs-zod` global-pipe boundary
  (exactly which params validate) was reasoned, consistent with prior sweeps.
- **Out of scope:** frontend render sinks, dependency CVEs, the transversal SEC-041 class on
  consumables/applications (noted above), deploy infra.

Related: [[summary]] · [[deferred]] · [[INVARIANTS]] · [[_MOC]] ·
[[SEC-040-soft-deleted-parent-leaks-via-asset-includes|SEC-040]] ·
[[SEC-041-soft-delete-no-child-reconciliation-dangling-fk|SEC-041]]
