# Feature ideation — Inventory pillar (assets, models, locations, consumables)

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Product / Features**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The Inventory pillar already stores the data (warrantyEnd, minStock, assetTag) but barely acts on it — the highest-value work is bulk CSV import/export, surfacing/alerting on data lazyit already collects, and one shared scheduler decision that unblocks four features at once.

## Findings (10)

### 1. CSV / spreadsheet bulk import & export of assets and consumables

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | medium | high |

- **Location:** `assets.service.ts:94-118; consumables.service.ts:69; precedent article-import.ts; multer in apps/api/package.json:51`
- **Why it matters:** Assets/consumables are created one row at a time (assets.service.ts:94, consumables.service.ts:69) — the onboarding wall for an IT generalist arriving with a spreadsheet/Snipe-IT export. The articles module already proves the multer+parse+create pattern (articles.service.ts:200-241), multer is already a dependency, and CSV import is table stakes vs Snipe-IT/GLPI. Export is also the concrete anti-vendor-lock-in ('everything exportable') guarantee.
- **Recommendation:** Add POST /assets/import and /consumables/import (multer buffer, validate each row vs CreateAssetSchema/CreateConsumableSchema, return per-row {created, errors[]} never a 500), resolve category/model/location by name; add GET .../export (CSV stream). Cap rows via env, mirror MAX_IMPORT_SIZE_MB.

### 2. Warranty / end-of-life expiry surfacing (then alerting)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | small | high |

- **Location:** `schema.prisma:143-144; asset.ts:35-36; filters in assets.service.ts:54-76 (no date filter)`
- **Why it matters:** FACT: Asset.warrantyEnd and purchaseDate are stored (schema.prisma:143-144) but NEVER queried — no filter, no 'expiring soon' view. This is the highest-leverage use of data lazyit already collects, answering the core audit question 'what do we have and is it still supported?' with near-zero new schema.
- **Recommendation:** Phase A (quick): add ?warrantyBefore=/?warrantyExpired=/expiring-within-N-days filters to GET /assets — no new tables. Phase B: real alerting, but design it together with AccessGrant.expiresAt and low-stock under one shared scheduler (Finding 9). NOT device monitoring — it reads a stored date.

### 3. minStock -> low-stock reorder workflow (close the loop ADR-0034 left open)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | small | high |

- **Location:** `consumables.service.ts:42-52; schema.prisma:437; ADR-0034:68`
- **Why it matters:** FACT: minStock is informative-only — powers a pull-only ?lowStock=true filter and nothing else (consumables.service.ts:42-52); ADR-0034:68 explicitly defers low-stock alerting. Consumables are a named pillar and 'we ran out of cables again' is daily reality for a small IT team.
- **Recommendation:** Add nullable reorderQty int4 to Consumable; GET /consumables/reorder-report (items <= minStock with suggested qty); keep restock as a normal IN movement (ledger already exists). Do NOT add POs/vendors here (separate bet).

### 4. Asset-tag / QR generation + scan-to-find

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | medium | medium |

- **Location:** `schema.prisma:137; assets.service.ts:62-69; search.service.ts:8-14`
- **Why it matters:** FACT: assetTag is a unique field already searchable via ?q= and Meili, but there is no tag generation (hand-typed -> collisions/drift) and no scan-to-find deep link. 'Scan the sticker -> see the record' is the most-loved Snipe-IT feature, IT-native, offline-friendly (QR encodes a relative URL to the self-hosted instance), no phone-home.
- **Recommendation:** Backend: optional auto-tag-on-create (opinionated default format) + GET /assets/by-tag/:tag. Frontend (separate subagent): QR/label print view encoding the by-tag URL. Confirm tag format with CTO (it's an exposed identifier).

### 5. Bulk assignment / transfer (multi-asset move & re-home)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | small | high |

- **Location:** `asset-assignments.service.ts:77-102; assets.service.ts:124-158`
- **Why it matters:** Every assignment/location change is one asset at a time (asset-assignments.service.ts:77, assets.service.ts:124). Real events are bulk: office move, person leaving (release all their assets), onboarding 5 items. Reusing the existing transactional history emitters yields correct AssetHistory events for free (ADR-0033). Directly serves the 'generalist under load' workflow.
- **Recommendation:** Add POST /asset-assignments/bulk, POST /assets/bulk-transfer (one tx, each emitting LOCATION_CHANGED), POST /asset-assignments/release-by-user/:userId. Reuse the per-row error shape from Finding 1. Not HR onboarding — just asset re-homing.

### 6. Location hierarchy (Site -> Building -> Room -> Rack)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | medium | medium |

- **Location:** `schema.prisma:55-74; location.md:27-28,59-65; ADR-0017:49-51`
- **Why it matters:** FACT: Location is flat (schema.prisma:55-74); hierarchy is named deferred debt (ADR-0017 follow-up, location.md:59-65). The vision explicitly lists datacenter/racks/Cisco gear — hierarchy IS that team's mental model; 'show me everything in Rack R12' and roll-up counts a flat model cannot answer.
- **Recommendation:** PROPOSAL superseding ADR-0017 follow-up: add self-referential parentId String? (cycle-guard in service), support ?parentId= and descendants roll-up. Requires a new ADR + CTO decision (onDelete policy). Keep type as-is (orthogonal).

### 7. Maintenance scheduling & service log on assets

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | large | medium |

- **Location:** `schema.prisma:163-170,210-244; assets.service.ts:226-228; ADR-0033`
- **Why it matters:** FACT: AssetStatus.IN_MAINTENANCE exists and status changes emit STATUS_CHANGED history, but there is no maintenance record (when/what/by whom/next due). Servers/switches/UPS need periodic service; recording it is core to 'what do we have and is it healthy?' Built on the existing append-only event philosophy.
- **Recommendation:** Defer behind Findings 2 & 9; then add a thin AssetMaintenance model + GET/POST /assets/:id/maintenance with optional nextDueAt feeding the scheduler. ANTI-GOAL WATCH: keep it human-entered log+reminder, NOT live device telemetry/monitoring (explicit anti-goal).

### 8. Supplier / PO linkage + cost & depreciation tracking — gate hard

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | low | large | low |

- **Location:** `schema.prisma (no Supplier/PurchaseOrder, no Decimal); ADR-0034:68`
- **Why it matters:** No money type exists anywhere (grep Decimal/cost/price -> 0 hits); ADR-0034:68 defers supplier/unit-cost. This is the riskiest item: money needs a deliberate Decimal+currency type decision and depreciation needs a method choice — opinionated product calls that edge toward finance/procurement, flirting with the 'NOT a CRM'/scope-creep line.
- **Recommendation:** Do NOT build now. If pursued: separate ADR for the money type (@db.Decimal + zod brand, single configurable currency, no FX); add Asset.purchaseCost first; minimal Supplier reference, NOT a PO/invoicing engine. Escalate to CTO/CEO — product-boundary call.

### 9. Scheduled stocktake / audit mode + the shared scheduler it requires

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | medium | large | medium |

- **Location:** `no scheduler in apps/api/src; consumables.service.ts:120-123; access-grant.ts:29`
- **Why it matters:** FACT: no scheduler/cron anywhere in the repo (grep @nestjs/schedule/cron/BullMQ -> 0 hits); ConsumableMovement.ADJUSTMENT already does an absolute physical recount (consumables.service.ts:120-123). Audit mode forces the shared scheduler decision that warranty alerts (F2), low-stock alerts (F3), maintenance reminders (F7) and AccessGrant.expiresAt all wait on. Decide once.
- **Recommendation:** New ADR choosing @nestjs/schedule (in-process cron, no Redis — best for the one-command self-hosted operator) vs BullMQ+Redis. Then build asset audit sessions (checklist per location -> AssetHistory events) and consumable recount on top. Human-driven physical audit, not device polling.

### 10. Asset lifecycle automation (RETIRED/LOST auto-releases assignments)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| optimization | low | small | medium |

- **Location:** `assets.service.ts:124-158; asset-assignments.service.ts; schema.prisma:163-170`
- **Why it matters:** Status transitions are unconstrained and have no side effects (assets.service.ts:124-158). An owner can 'own' a LOST/RETIRED laptop indefinitely (still shown in activeAssignments, asset.md:58-61). 'Opinionated over configurable' says lazyit should encode the obvious IT rule so the generalist doesn't have to remember it; cheap, reuses existing transactional emitters.
- **Recommendation:** In the asset update transaction, when status -> RETIRED/LOST, auto-release active assignments and emit RELEASED. Make it opinionated default, not a setting. Confirm exact trigger statuses with CTO. Avoid a general workflow engine (scope creep) — ship 1-2 concrete rules.

## Quick wins

- Warranty/EOL read filters: add ?warrantyBefore=/?warrantyExpired= to GET /assets — pure additive filter in assets.service.ts:54-76 reusing existing warrantyEnd (schema.prisma:144), no schema change. Highest value-per-hour.
- reorderQty column + GET /consumables/reorder-report: one nullable int4 + a read built on the existing lowStock query (consumables.service.ts:42-52).
- GET /assets/by-tag/:tag: thin lookup on the already-unique assetTag (schema.prisma:137) — unblocks scan-to-find with no schema change.
- POST /asset-assignments/release-by-user/:userId: release all active assignments for a departing user in one transaction, emitting RELEASED, reusing existing emitters.
- ?purchaseBefore= / asset-age filter on GET /assets: same trivial pattern, surfaces aging fleet for refresh planning.

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
