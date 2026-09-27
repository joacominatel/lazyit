---
title: "ADR-0033: AssetHistory event model"
tags: [adr]
status: accepted
created: 2026-05-26
updated: 2026-09-25
deciders: [Joaquín Minatel]
---

# ADR-0033: AssetHistory event model

## Status

accepted — 2026-05-26. Third front of the backend-completion epic (#4, sub-issue #9). Realizes the
[[asset-history]] entity planned since [[0006-soft-delete-and-auditing]], builds on the soft-delete
extension ([[0032-soft-delete-middleware]]) and the `X-User-Id` shim ([[0022-draft-visibility-auth-shim]]),
and closes (in part) the actor-helper follow-up of [[0024-asset-assignment-actor-shim]].

## Context

Auditability is a first principle: "what changed, when, by whom?" must be answerable for an asset.
The [[asset-history]] note has been ⚪ planned since the schema was split by mutability ([[0006-soft-delete-and-auditing]]).
Implementing it forces concrete choices: how events are shaped, how they're triggered, who the actor
is, and how the timeline is read.

## Considered options

**(1) Event granularity — one generic "UPDATED" row vs discrete typed events.** A single UPDATED
event with a diff blob is opaque. → **Discrete `eventType` enum** (`CREATED`, `STATUS_CHANGED`,
`ASSIGNED`, `RELEASED`, `LOCATION_CHANGED`, `MODEL_CHANGED`, `SPECS_CHANGED`, `DELETED`, `RESTORED`):
a readable, filterable timeline. An update that changes several fields emits **several** discrete rows.

**(2) Trigger — a magic Prisma/Nest interceptor vs explicit service calls.** An interceptor that
guesses events from ORM operations is fragile (it can't know intent — e.g. assign vs release are both
"create/update" rows). → **Explicit service calls**: the service that performs the change records the
event, **transactionally** (`$transaction`) so the log row commits atomically with the change.

**(3) Actor — body field vs the `X-User-Id` shim.** Consistent with every other "who acted" field
(ADR-0022/0023/0024). → **`performedById` from the shim**, resolved by a new shared **`ActorService`**
(the third caller the [[0024-asset-assignment-actor-shim]] follow-up anticipated). Optional /
`SetNull`: a system actor leaves it `null`.

**(4) Pagination — offset vs cursor.** The id is a monotonic autoincrement, a natural cursor. →
**cursor on `id`** (`before` returns rows with `id < before`), newest first, `limit` 1–100 (default 50).

## Decision

- **Model `AssetHistory`** ([[asset-history]]): `id` (autoincrement — log, [[0005-id-strategy]]),
  `assetId` (FK, required, `Restrict`), `eventType` (enum), `payload?` (jsonb — e.g. `{ from, to }`),
  `performedById?` (FK → [[user]], `SetNull`), `createdAt` only (append-only, [[0006-soft-delete-and-auditing]]).
  Index `(assetId, id)` serves the timeline query.
- **Emission** is explicit and transactional: the **[[asset]] service** emits `CREATED`, the per-field
  `STATUS_CHANGED` / `LOCATION_CHANGED` / `MODEL_CHANGED` / `SPECS_CHANGED` (diffing the row before vs
  after the update; `SPECS_CHANGED` carries no payload as specs can be large, and the specs diff uses
  an **order-insensitive deep compare** — `apps/api/src/common/deep-equal.ts` — not `JSON.stringify`,
  because `jsonb` does not preserve object key order, so reordered keys must not emit a spurious
  `SPECS_CHANGED`), and `DELETED`; the **[[asset-assignment]] service** emits `ASSIGNED` and `RELEASED`
  (both carrying `{ userId }` so a multi-owner asset's timeline is attributable per owner). `RESTORED` is emitted by the asset
  restore endpoint (`POST /assets/:id/restore`, [[0041-soft-delete-reuse-and-restore]]) — the
  counterpart of `DELETED`. (It was reserved-without-emitter until ADR-0041.)
- **`AssetHistoryService`** owns `record(client, event)` (called with the transaction client) and
  `list(assetId, { limit, before })`.
- **Actor via the shared `ActorService`** (`apps/api/src/common/actor.service.ts`): resolves the
  optional `X-User-Id` (absent → null actor; present → must be a live user, else 400 — soft-deleted
  users are filtered by [[0032-soft-delete-middleware]], so they 400 too). The **Asset write endpoints
  gained an optional `X-User-Id` header** (additive; no body-contract change). AssetAssignment was
  migrated to `ActorService`; **AccessGrant still has its private copy — migrating it is a small
  remaining follow-up.**
- **Endpoint** `GET /assets/:id/history?limit=&before=` on `AssetsController` (cursor pagination;
  404 if the asset is missing / soft-deleted).

## Consequences

- **Positive:** a precise, filterable, attributable per-asset timeline; events are atomic with the
  change; the actor model stays consistent (header → JWT later); `ActorService` removes the
  duplicated resolver for two of its three callers.
- **`payload` is unvalidated jsonb** — the same debt as `Asset.specs` ([[0007-flexible-asset-specs-jsonb]]).
- **No nested-history pruning / retention** — the log grows unbounded; a retention policy is a future
  decision (acceptable at small-team scale).
- **`RESTORED` now has an emitter** — the asset restore endpoint ([[0041-soft-delete-reuse-and-restore]])
  clears `deletedAt` and records `RESTORED` transactionally, using the `includeSoftDeleted` escape
  hatch of [[0032-soft-delete-middleware]] to find the deleted row. (It was unemitted until ADR-0041.)
- **Follow-up:** migrate `AccessGrantsService` to `ActorService` (finishing the
  [[0024-asset-assignment-actor-shim]] dedupe); a frontend timeline on the asset detail page.

## Amendment — 2026-09-25: plain-field edits write one `UPDATED { fields }` row (#1382)

**CEO decision, 2026-09-25.** Until now an asset edit that touched only *plain* fields — `name`,
`serial`, `assetTag`, `notes`, `company`, `purchaseDate`, `warrantyEnd`, `purchaseCost`,
`usefulLifeMonths`, `salvageValue`: every `UpdateAsset` field without a discrete event of its own —
wrote **no** history row on any path (UI, API, the AI `asset_update` tool). Such edits never reached
the `recent_activity` view or Reports, and an AI-made plain edit left no `aiInvocationId`-stamped trail
in the domain history (only [[ai-action-log]]).

**Decision.**

- `AssetsService.update` writes **one** `UPDATED` row per PATCH, payload `{ fields: [...] }`, naming the
  plain fields whose stored value **actually changed** (before snapshot vs updated row; a date compared by
  instant, a missing value as `null`, so clearing `purchaseCost` to `null` counts). No row when nothing
  plain changed — a no-op edit writes nothing. Field order is fixed (the declaration order above).
- **Field names only — never the old or new values.** Rationale: auditability needs *what* was touched,
  *when* and *by whom*; the values live on the asset itself. Copying them into an append-only log would
  duplicate cost data (`purchaseCost`, `salvageValue`) and free text that may hold sensitive notes into a
  table that can never be edited or pruned. Mirrors `UserHistory.UPDATED { fields }` ([[0050-user-history-and-activity-user-entity]]).
- **Discrete events keep their own rows.** A PATCH that changes a discrete dimension (status / location /
  model / specs) *and* plain fields writes both: the discrete row(s) as before, then one `UPDATED` listing
  **only** the plain fields. `specs` stays `SPECS_CHANGED` and is never listed in `fields`.
- **Every path lands on the one emitter.** The web UI, the REST API, the AI `asset_update` tool and each
  row of `asset_update_batch` all dispatch to `PATCH /assets/:id`, so the row carries the actor
  (`performedById` / `serviceAccountId`, [[0048-service-accounts]]) and, for an AI call, the
  `aiInvocationId` ([[0097-ai-assistant-mcp-and-headless-api]] decision 11).
- **Re-import (#1061) unchanged in spirit.** A migrator re-import that changes plain fields writes this
  same `UPDATED { fields }` row with the `{ source, sessionId, rowIndex }` provenance merged in; the bare
  provenance-only `UPDATED` marker is written only when nothing changed at all. Still exactly one
  `UPDATED` row per re-imported asset.
- The exhaustive plain-field list is typed against `UpdateAsset`, so a new editable field fails the type
  check until it is either listed or given its own discrete event.

**No migration.** `AssetHistoryEventType.UPDATED` already exists (#1061) and the `recent_activity` view
reads the asset branch generically (`action = 'updated'`, summary "Asset updated"), so Reports shows the
row with its actor as soon as it is written. **Upgrade-safety:** existing history is untouched; plain
edits made before the update have no row and none is backfilled — new rows only from now.

Related: [[asset-history]] · [[asset]] · [[asset-assignment]] · [[user]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[0022-draft-visibility-auth-shim]] ·
[[0024-asset-assignment-actor-shim]] · [[0032-soft-delete-middleware]] · [[prisma-migrations]]
