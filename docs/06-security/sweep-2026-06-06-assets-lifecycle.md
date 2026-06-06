---
title: Sweep 2026-06-06 — assets / asset-assignments / asset-history lifecycle
tags: [security, sweep, assets, asset-assignments, asset-history]
status: draft
created: 2026-06-06
updated: 2026-06-06
---

# Sweep — assets · asset-assignments · asset-history (2026-06-06)

Deep audit of the inventory-lifecycle triplet and its integration with the rest of the API, per the
`lazyit-sentinel` method. Reserved range **SEC-030..SEC-039**; used **SEC-030..SEC-032**.

## Scope

- `apps/api/src/assets` — asset CRUD, flexible `specs` jsonb, FK refs (model/location/category),
  soft-delete (single + batch), restore, history emission, search projection.
- `apps/api/src/asset-assignments` — assign/release lifecycle, the partial-unique-index race backstop,
  actor attribution (human vs service account), `releaseAllForUser` (offboarding).
- `apps/api/src/asset-history` — append-only event model, the actor choke point
  (`performedById` XOR `serviceAccountId`).
- Integration read: `prisma/schema.prisma`, the `add_asset_assignment_model` + `add_service_accounts`
  migrations (partial unique index + at-most-one-actor CHECKs), the soft-delete extension,
  `packages/shared` schemas (asset / asset-assignment / asset-history / batch), the controllers'
  `@RequirePermission` gating, and the nested `/users/:id/assignments`, `/assets/:id/assignments`,
  `/assets/:id/history` surfaces.

Method: classes from skill §1 run against each flow; ADRs cross-checked; PoCs **reasoned, not
executed** (API/DB not started). App code read-only.

## Findings

| ID | Sev | Class | One-line |
| --- | --- | --- | --- |
| [[SEC-030-asset-unguarded-soft-deleted-model-location-fk\|SEC-030]] | 🟡 Low | soft-delete bypass | Asset create/update accept a soft-deleted `modelId`/`locationId` (no liveness guard; asymmetric with assignments/articles) |
| [[SEC-031-assignment-release-toctou-duplicate-history\|SEC-031]] | 🟡 Low | TOCTOU / audit integrity | Release has no DB backstop — concurrent/double-click release double-emits `RELEASED` history and overwrites the actor |
| [[SEC-032-asset-specs-deep-nesting-recursion-dos\|SEC-032]] | 🟡 Low | DoS (recursion) | Deeply-nested `specs` overflows the recursive `jsonDeepEqual` on update → unmapped 500 |

No Critical / High / Medium this sweep.

## Verified clean (checked, nothing to file)

- **Assignment create RACE is genuinely backstopped.** The `findFirst` pre-check
  (`asset-assignments.service.ts:84-91`) is friendly only; the partial unique index
  `asset_assignments_assetId_userId_active_key … WHERE "releasedAt" IS NULL`
  (`migrations/20260526120000_…/migration.sql:29-31`) is the race-proof guard → P2002 → 409 via
  `PrismaExceptionFilter`. Confirmed present in SQL, matches schema note (`schema.prisma:433-436`) and
  ADR-0019. Correct pattern, not a bug. (Contrast: the *release* path lacks the analogue — SEC-031.)
- **Actor attribution — no spoofing, at-most-one actor holds.** The actor is resolved from the
  guard-set `@CurrentPrincipal()` (`ActorService.resolveActor`, `common/actor.service.ts:43-51`),
  never the body; `Create/Release/UpdateNotes` schemas are `z.strictObject` with **no** actor field
  (`packages/shared/.../asset-assignment.ts:45-67`). `resolveActor` returns at most one of
  `{userId}|{serviceAccountId}`, and the DB **CHECK**s enforce it at rest — one per actor slot on
  `asset_assignments` (assigned/released) and on `asset_history`
  (`migrations/20260602232921_…/migration.sql:134-156`). INV-SA-4 upheld; human and SA writes land in
  the right column, never a fabricated `userId`.
- **AssetHistory is a clean choke point.** `AssetHistoryService.record` (`asset-history.service.ts:43-62`)
  is the single writer; it spreads the resolved actor (XOR), is always called with a `$transaction`
  client by `assets.service.ts` and `asset-assignments.service.ts` (atomic with the change), and the
  table is append-only (no `updatedAt`/`deletedAt`, autoincrement id, `onDelete: Restrict` on the asset
  FK). History read (`list`) uses a positive-int cursor (`before`) + `limit` ≤ 100 — bounded.
- **Soft-delete reads are consistent on the audited entities.** Asset reads use `findFirst`/`findMany`
  (extension scopes `deletedAt: null`, `soft-delete.extension.ts`); `findOne`/`assertExists` 404 a
  soft-deleted asset; `restore` correctly uses the `includeSoftDeleted` escape hatch. The `deleted=only`
  archived slice is ADMIN-gated at the controller (`assertCanListDeleted`). Assignment create guards
  **both** parents it owns — `assertAssetUsable` + `assertUserUsable` 400 on a soft-deleted asset/user
  (`asset-assignments.service.ts:221-247`). (The gap is only the asset→model/location refs — SEC-030.)
- **Mass assignment contained.** `CreateAsset`/`UpdateAsset`/batch payloads are `z.strictObject`
  (unknown keys rejected) and omit server-owned fields (`id`, `*At`, actor FKs, `deletedAt`). Batch ids
  are bounded + de-duplicated (`MAX_BATCH_IDS = 200`, `packages/shared/.../batch.ts:17-26`) — no
  unbounded write fan-out.
- **AuthZ gating present on every route.** All asset/assignment reads carry `@RequirePermission('asset:read')`;
  writes `asset:write`; destructive/batch `asset:delete`; nested `/users/:id/assignments` is `user:read`,
  `/assets/:id/articles` is `article:read`. No unannotated route in the triplet (service accounts are
  fail-closed on those — INV-SA-2).
- **No raw SQL / exec / fs.** No `$queryRaw`/`$executeRaw`, no `child_process`/`eval`, no disk writes in
  any of the three modules — all access is parameterized Prisma. (Re-grepped this sweep.)

## Integration risks (noted, not separately filed)

- **Assignment-create vs offboarding TOCTOU (same class as SEC-030, race variant).**
  `assertUserUsable`/`assertAssetUsable` run *outside* the create transaction. A user offboarded
  (`users.service.remove`, which `releaseAllForUser` + soft-deletes inside one tx) concurrently with an
  in-flight `POST /asset-assignments` can leave a fresh **active** assignment pointing at a now
  soft-deleted user (the create read old state, then committed after the offboard). Narrow (needs the
  race) and benign (FK still valid, row just references an archived user); folded into the live-parent
  remedy of SEC-030 (re-assert liveness inside the write, or accept + document).
- **`assignedAt` backdating is unbounded.** `CreateAssetAssignmentSchema.assignedAt` accepts any ISO
  datetime (past or future) with no sanity bound; an `asset:write` caller can backdate/forward-date an
  ownership record. Data-quality, not security (history `createdAt` is still server-set); note for a
  future bound if assignment timelines become trust-sensitive.
- **Soft-deleted parents surface through relation includes.** Asset detail/list `include` of
  `model`/`location` is not soft-delete filtered (relation includes bypass the extension); for
  `assignments.user` this is **intentional** (the lean select carries `user.deletedAt` to dim a departed
  owner — `assets.service.ts:98-106`). For model/location it is the read-side face of SEC-030.
- **`specs` jsonb downstream sink (DEF-004) unchanged.** Stored unvalidated; server risk is the
  recursion (SEC-032). The render/URL sink risk remains a Phase-3 frontend concern (relates to SEC-003).

## Coverage & gaps

- **Covered:** all three modules end-to-end (single + batch + restore + offboarding release), the
  create-race backstop verified against the migration SQL, the actor XOR verified against the CHECK
  constraints, soft-delete read consistency, authZ annotations, and the cheap injection/exec/fs
  invariants.
- **Lighter:** exact stack-overflow depth for SEC-032 is environment-dependent (reasoned from the
  unbounded-recursion shape, not measured); no dynamic testing (API not run); the `nestjs-zod` global
  pipe boundary was reasoned, not exercised.

Related: [[summary]] · [[INVARIANTS]] (INV-SA-4) · [[deferred]] (DEF-004, DEF-005) · [[_MOC]]
