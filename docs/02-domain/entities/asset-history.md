---
title: AssetHistory
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-09-25
---

# AssetHistory

> 🟢 implemented · Area: Assets (core) · Implementation order: 3 · see [[0033-asset-history-event-model]]

## Purpose

An **append-only** log of discrete state changes for an [[asset]] — creation, status transitions,
location / model moves, spec edits, plain-field edits (which fields, not their values), ownership
changes (assign / release) and soft-delete. Provides
the "what changed, when, by whom?" trail that auditing requires ([[problem-space]]).

## Fields

- `id` — `autoincrement()`; a log id, never exposed externally ([[0005-id-strategy]]).
- `assetId` — FK → [[asset]], required, `onDelete: Restrict` (an asset with history can't be
  hard-deleted; soft delete bypasses it).
- `eventType` — `AssetHistoryEventType` enum (below).
- `payload` — optional jsonb; contextual data (e.g. `{ from, to }` on `STATUS_CHANGED`,
  `{ userId }` on **both `ASSIGNED` and `RELEASED`** — so a multi-owner asset's timeline can tell
  which owner was assigned/released), `{ fields: [...] }` on `UPDATED` (the plain field *names* that
  changed — never values). Unvalidated, same debt as `Asset.specs` ([[0007-flexible-asset-specs-jsonb]]).
- `performedById` — optional FK → [[user]], `onDelete: SetNull`; the **human** actor, resolved from the
  verified principal (`@CurrentPrincipal()` → `request.user`, not a token claim; the `X-User-Id` header
  is the dev-only shim path — [[0038-jit-user-provisioning]], [[0022-draft-visibility-auth-shim]]).
  `null` = system / unknown.
- `serviceAccountId` — optional FK → [[service-account]], `onDelete: SetNull`; the **non-human** actor
  when a service account performed the action ([[0048-service-accounts]]). A DB **CHECK** enforces
  *at most one* of (`performedById`, `serviceAccountId`) per row — honest attribution, never a fake human
  ([[INVARIANTS]] INV-SA-4). `ActorService.resolveActor(principal)` picks the right column.
- `aiInvocationId` — optional plain string (no FK, no index): the [[ai-tool-invocation]] that caused
  the event, stamped from the AI invocation context when an AI tool performed the write
  ([[0097-ai-assistant-mcp-and-headless-api]] decision 11). `null` for every other write and every row
  that existed before the column. The actor columns still name the real principal — the AI acts *as* it;
  this column only adds provenance. The permanent record of the AI action is [[ai-action-log]], which
  carries the same id after the invocation row is retention-pruned.
- `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]).

## Events (`AssetHistoryEventType`)

`CREATED` · `STATUS_CHANGED` · `ASSIGNED` · `RELEASED` · `LOCATION_CHANGED` · `MODEL_CHANGED` ·
`SPECS_CHANGED` · `DELETED` · `RESTORED` (emitted by `POST /assets/:id/restore`, the counterpart of
`DELETED` — [[0041-soft-delete-reuse-and-restore]]) · `UPDATED` (a plain-field edit, payload
`{ fields }` naming the plain fields that changed — [[0033-asset-history-event-model]] amendment
2026-09-25, #1382; also the "updated via re-import" marker — a bulk import that matches a live asset by
serial UPDATEs it, and when nothing changed a provenance-only `UPDATED` is written so the re-import still
leaves one audit row; [[0069-migrator-import]] #1061) ·
`ACKNOWLEDGED` (emitted by `POST /asset-assignments/:id/acknowledge` when the assignee confirms receipt —
ADR-0089 Part B, #1029) · `AGENT_LINKED` (an agent-reported [[infra-node]] **adopted** this asset at its
confirm gate — [[0093-chassis-routing-and-asset-adoption]] §4, #1198; payload
`{ nodeId, reportingSource, externalId }`) · `CONSUMABLE_DELIVERED` (a consumable was delivered to this
asset: a targeted `OUT` [[consumable-movement]] — [[0098-consumable-delivery-targets]], #1364; payload
`{ consumableId, consumableName, movementId, quantity, unit }`) · `CONSUMABLE_RETURNED` (a return
against a returnable delivery made to this asset: an `IN` linked by `returnOfId`; the same payload plus
`{ returnOfId }`, the delivery movement id).

## Emission

**Explicit service calls** (no interceptor), **transactional** with the change ([[0033-asset-history-event-model]]):

- [[asset]] service — `CREATED` (create); per-field `STATUS_CHANGED` / `LOCATION_CHANGED` /
  `MODEL_CHANGED` / `SPECS_CHANGED` (update diff, one event per changed field); `DELETED` (soft delete);
  `UPDATED` — **one** row per PATCH whose plain fields (`name`, `serial`, `assetTag`, `notes`, `company`,
  `purchaseDate`, `warrantyEnd`, `purchaseCost`, `usefulLifeMonths`, `salvageValue`) actually changed,
  payload `{ fields }` with the names only, never the values (#1382). A no-op edit writes nothing. A PATCH
  that also moves a discrete dimension writes both: the discrete row(s), then `UPDATED` listing only the
  plain fields. Every path — UI, API, the AI `asset_update` tool and each `asset_update_batch` row —
  goes through `PATCH /assets/:id`, so the row carries the actor and, via the AI, `aiInvocationId`. On a
  migrator re-import the row also carries `{ source, sessionId, rowIndex }`, and when nothing changed a
  provenance-only `UPDATED` marker is written instead ([[0069-migrator-import]] #1061).
- [[asset-assignment]] service — `ASSIGNED` (open), `RELEASED` (release) and `ACKNOWLEDGED`
  (self-service acknowledgement of receipt; payload `{ userId }` = the acknowledging owner — #1029).
- [[consumable]] service — `CONSUMABLE_DELIVERED` (an `OUT` targeting this asset) and
  `CONSUMABLE_RETURNED` (an `IN` returning such a delivery). Both are written through
  `AssetHistoryService.record` on the **movement's transaction client**, with the movement's principal as
  actor (and `aiInvocationId` when an AI tool made the call). A user or location target writes no asset
  event ([[0098-consumable-delivery-targets]]).
- [[infra-node]] service — `AGENT_LINKED`, and **only** that one. Emitted **exactly once**, at the moment
  a confirm adopts an existing asset instead of minting one ([[0093-chassis-routing-and-asset-adoption]]
  §3/§4, #1198). The recurring path is deliberately **silent**: `syncAssetSpecs` refreshes an adopted
  asset's `specs` on every check-in with **no** `SPECS_CHANGED`, because an event per report at a
  five-minute cadence would bury every human edit the row ever received. What *moved* is audited on the
  node instead ([[infra-node-fact-change]], #1143), one join away. Best-effort: a failed write logs and
  never fails the confirm (on the auto-confirm path it would fail a *report*).

## Endpoint

`GET /assets/:id/history?limit=&before=` — newest first; `limit` defaults to 50 (max 100); `before`
is an exclusive cursor on the autoincrement id. 404 if the asset is missing or soft-deleted.

## Business rules

- **Append-only and immutable.** Rows are written, never updated or deleted.

## Conventions

- **ID:** `autoincrement()` — log entity ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only (no `updatedAt` / `deletedAt`, [[0006-soft-delete-and-auditing]]).

Related: [[asset]] · [[asset-assignment]] · [[consumable-movement]] · [[user]] · [[service-account]] ·
[[0033-asset-history-event-model]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[0022-draft-visibility-auth-shim]] · [[0048-service-accounts]] · [[INVARIANTS]]
