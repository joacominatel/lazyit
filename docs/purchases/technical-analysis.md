---
title: "Purchases — pre-implementation technical analysis"
tags: [purchases, research, architecture, data-model]
status: draft
created: 2026-10-01
updated: 2026-10-01
---

# Purchase Orders: pre-implementation technical analysis

> [!warning] Pre-decision research — [[0099-purchases-scope-model-and-optionality|ADR-0099]] is authoritative
> The system-side analysis written before the CEO's decisions of 2026-10-01. File and line references
> are to the repository as it was on that date. Where it differs from
> [[0099-purchases-scope-model-and-optionality|ADR-0099]], [[0100-money-as-64-bit-minor-units|ADR-0100]]
> or [[purchases/decisions|the decisions note]], those win. Notable differences: currency is **per
> purchase** (not one implicit instance currency) and the asset cost gains an optional currency; money
> moves to **64-bit** integers (§7 risk 2 and decision 9 are superseded); the reference is **optional**;
> *Received* is **derived**, not a user-set status; there are no header tax or shipping amounts
> (shipping is an `OTHER` line); and consumable lines come in Phase **1b**. Entity design: [[supplier]]
> · [[purchase-order]] · [[purchase-order-line]] · [[purchase-order-event]]. Back to
> [[purchases/_MOC|the Purchases vault]].


## Executive summary

- **Nothing called a purchase order exists today.** Purchase data lives as six nullable columns on `Asset`: `purchaseDate`, `warrantyEnd`, `purchaseCost`, `usefulLifeMonths`, `salvageValue` (and `company`). `Application` has `vendor`, `seatsPurchased`, `costPerSeat` and `renewalDate`. **There is no order-number field, no supplier/vendor entity and no invoice concept anywhere.** I searched `apps/`, `packages/` and `docs/` for `orderNumber|purchaseOrder|supplier|invoice|purchase order`. The only hits were two test filenames and one "deferred" line in ADR-0034.
- **Building POs reverses a recorded decision.** ADR-0089 calls a PO entity a non-goal and cites [[vision]] for "no ticketing/procurement" (`docs/03-decisions/0089-bulk-receiving-and-checkout-acknowledgement.md:29-31`). `vision.md` itself only lists ticketing as a non-goal (`docs/00-overview/vision.md:57-66`), so the two documents already disagree. ADR-0088 also deferred "PO numbers, vendor SKUs" to a future entity (`0088-…:73-75`). The CEO has to approve the scope change explicitly, and a new ADR (next free number: 0099) has to set its limits.
- **Most of the pieces already exist:**
  - Bulk asset creation that loops the single-asset create and returns partial success (`POST /assets/batch/receive`, ADR-0089).
  - Polymorphic file attachments (ADR-0082).
  - The AI tool framework, with batch tools, approval cards, mutation weights and `request_input`.
  - Several "OFF by default" singleton settings to copy for the on/off switch.
  - A seed-once permission ledger, so new permissions reach existing instances without a data migration.
- **Missing pieces:**
  - **Reading a PO from a file.** There is no PDF or OCR library in the repo.
  - **AI chat cannot take files.** It is text-only (`packages/shared/src/schemas/ai-run.ts:203-206`, `apps/api/src/ai/providers/aisdk-chat-model.ts:109-110`), and file attachments in chat are an explicit v1 non-goal (`docs/ai-assistant/_synthesis.md:670`).
  - **Uploaded files are not backed up.** The attachments volume is outside every backup (`docs/05-runbooks/backups.md:33,83-92`).
- **Recommendation:**
  - **Data model:** a thin PO with three new tables: `Supplier`, `PurchaseOrder`, `PurchaseOrderLine`. Add one nullable `Asset.purchaseOrderLineId` and an append-only `PurchaseOrderEvent` log.
  - **Asset fields stay the source of truth.** PO values are copied onto an asset (a snapshot) when it is generated from or linked to a PO, after the user confirms. Nothing that reads asset purchase fields today has to change.
  - **Delivery in three phases:** manual MVP, then extraction, then AI chat.
  - **Extraction design:** a server-side call with no tools that only returns structured data, reviewed by a human before anything is saved. It reads a PDF already uploaded to the PO, not a file sent in the chat.
- **Biggest technical risk: money size.** Amounts are stored in 32-bit integers (int4) as minor units (cents). The ceiling is **21,474,836.47 major units per stored value** (`packages/shared/src/schemas/primitives.ts:13-14`). In a currency with large nominal amounts (ARS, CLP, COP and similar), a PO total stored in the same format overflows on ordinary orders. Totals must be computed in the app, never stored, and the CEO needs to say which currencies the target users work in.

---

## 1. Current state

### 1.1 Purchase-related fields that exist today

| Where | Field(s) | Evidence |
| --- | --- | --- |
| `Asset` | `purchaseDate DateTime?`, `warrantyEnd DateTime?` | `apps/api/prisma/schema.prisma:622-623` |
| `Asset` | `purchaseCost Int?`, `usefulLifeMonths Int?`, `salvageValue Int?`. Integer minor units of "the instance's single currency"; no Decimal type and no currency modelled. | `schema.prisma:624-630`; `docs/02-domain/entities/asset.md` (Fields table and "Depreciation") |
| `Asset` | `company String?`: a free-text grouping label, not an entity | `schema.prisma:614-621`; ADR-0076 |
| `Asset` (computed) | `currentBookValue`, computed on read and never stored (`computeAssetBookValue`) | `asset.md` §Depreciation; `packages/shared/src/utils/asset-depreciation.ts` |
| `AssetModel` | `manufacturer String` (required, free text), `name`, `sku?`, `categoryId?` | `schema.prisma:576-596`; `docs/02-domain/entities/asset-model.md:53-54` |
| `AssetCategory` | `name`, `specsSchema Json?`, an optional dictionary of suggested spec fields (ADR-0078) | `schema.prisma:551-572` |
| `Application` | `vendor String?` (free text), `seatsPurchased Int?`, `costPerSeat Int?` (minor units), `renewalDate DateTime?` | `schema.prisma:1467-1468, 1479-1487`; ADR-0088 |
| `Consumable` / `ConsumableMovement` | **No cost and no supplier.** "supplier / unit-cost tracking" is explicitly deferred. | `schema.prisma:1654-1749`; `docs/03-decisions/0034-consumables-design.md:70-71` |
| Shared contract | `purchaseCost`/`usefulLifeMonths`/`salvageValue` are `int4({ min: 0 })`; dates are ISO strings | `packages/shared/src/schemas/asset.ts:140-150, 171-176, 193-199` |
| Bulk receive contract | `ReceiveAssetsSchema` with `modelId` (required), `quantity` 1..200, `purchaseDate?`, `purchaseCost?`, `serials?`. **No `warrantyEnd`.** | `packages/shared/src/schemas/asset-receive.ts:24-55`; `apps/api/src/assets/assets.controller.ts:661-662` |
| AI tools | `asset_create_batch` shares `purchaseDate`, `warrantyEnd`, `purchaseCost`, `usefulLifeMonths`, `salvageValue` across up to 200 rows. `mutationWeight` = number of rows. | `apps/api/src/ai/tools/assets.tools.ts:753-769, 1206-1222` |
| Import (ADR-0069) | Maps `purchaseDate`, `warrantyEnd`, `purchaseCost`, `usefulLifeMonths`, `salvageValue`. **No alias for order number or supplier**, so those columns can only go into custom `specs` fields. | `packages/shared/src/schemas/import/descriptor.ts:78-85, 194-210`; Manual `es/assets-bulk-import.md:92` |
| CSV export | Includes `purchaseDate` and `warrantyEnd`; **leaves out `purchaseCost`** | `packages/shared/src/utils/asset-inventory-csv.ts:23-58` |
| Clone (ADR-0058) | Copies `purchaseDate` and `warrantyEnd` | `packages/shared/src/clone/clone-defaults.ts:89-103` |
| Dashboard / notifications | Warranty tile and `warranty_expiring` sweeper read `Asset.warrantyEnd` | `apps/api/src/dashboard/dashboard.service.ts:107-133`; `apps/api/src/notifications/expiry-notifications.sweeper.ts` |
| Search | Purchase fields are **not** indexed. Global search only shows dates in the quick-view preview. | No hits in `apps/api/src/search`; `apps/web/components/global-search.tsx:747-748` |
| Web | Asset form edits cost in major units, kept outside react-hook-form; `formatMoney` prints the number with no currency | `apps/web/app/(app)/assets/_components/asset-form.tsx:219-237`; `apps/web/lib/utils/money.ts:1-33` |
| Manual | "Cost & depreciation", bulk receiving, import money columns | `apps/web/content/manual/en/assets-asset-basics.md:27-28, 99-113, 191`; `…/assets-bulk-receiving.md`; `…/assets-bulk-import.md` |

### 1.2 Brand, model and type today

Brand and model are modelled as `AssetModel` (a free-text `manufacturer` plus a `name`). Type is the `AssetCategory` the model points to. Per-unit attributes live in `Asset.specs` (JSONB, ADR-0007), with advisory dictionaries per category (ADR-0078). Creating an asset from a model **copies the model's specs onto the asset as a snapshot** (`asset.md`, Business rules). That snapshot pattern is what I recommend for PO values below.

**No entity exists for Vendor, Supplier, Manufacturer or Company** (`Asset.company` is free text by decision, ADR-0076 at `schema.prisma:614-621`). A PO line's brand, model and type therefore have to resolve to an `AssetModel`, existing or newly created, before assets can be minted: bulk receive requires `modelId` (`asset-receive.ts`).

---

## 2. Constraints (ADRs, rules, invariants)

| Source | Constraint on POs |
| --- | --- |
| ADR-0089 l.29-31, ADR-0088 l.73-75, ADR-0034 l.70 | PO, receiving documents and suppliers are recorded as non-goals or deferred. **Needs an explicit CEO reversal and a new ADR.** |
| ADR-0004 / `asset-centric.md` | The asset stays the centre. A PO is provenance attached to assets, not a new centre; ownership is still never a column. |
| ADR-0006, `conventions.md` | Never hard-delete. Mutable entities get `updatedAt`/`deletedAt`; logs get `createdAt` only. PO edits and status changes need an append-only trail. |
| ADR-0032 | New soft-deletable models must be registered in `SOFT_DELETABLE_MODELS` (`apps/api/src/prisma/soft-delete.extension.ts:22-52`), or reads leak deleted rows (precedent #321). |
| ADR-0041 | Uniqueness on soft-deletable models uses raw-SQL partial unique indexes `WHERE "deletedAt" IS NULL`, plus ADMIN-gated restore. Applies to supplier name and PO number. |
| ADR-0033 | Asset events are explicit and written in the same transaction. Linking or unlinking an asset to a PO line is a discrete state change, so it gets new `AssetHistoryEventType` values (enum at `schema.prisma:1064+`, appended at the tail). The recent-activity view handles any new asset event type generically (`migrations/20260609130254_recent_activity_view_subject/migration.sql:35-36`). |
| ADR-0008 / ADR-0034 | Consumables are counted stock changed only through movements. A consumable PO line can only take effect as an `IN` movement, never as a direct `currentStock` write. |
| ADR-0036 | Every `Int` field uses `int4()`, range ±2,147,483,647. Money is in minor units, so **≤ 21,474,836.47 major units per stored value**. |
| ADR-0088 / #954 / `money.ts` | One implicit instance currency, no currency code, minor-unit integers, conversion in the web (`majorToMinor`). A second money convention is explicitly unwanted (`0088-…:27-29`). |
| ADR-0030 | New list endpoints must use `Page<T>` (default 50, max 200, a larger `limit` returns 400). |
| ADR-0040/0046, `docs/01-architecture/authorization.md` | Permissions are catalog-as-code `domain:action` strings, resolved from the database, enforced by `@RequirePermission`. Reads are seeded to all roles except the tighter tiers (`VIEWER_DENIED_READS`, `ADMIN_ONLY_READS`; §4). **There is no field-level authorization.** `Asset.purchaseCost` is visible to anyone with `asset:read`, VIEWERs included. |
| Seed-once ledger | A new permission gets its role defaults exactly once on deploy (`schema.prisma:292-305`, `AppliedRolePermissionDefault`), so the permission side of the upgrade is safe with no data migration. |
| ADR-0029 | Store text as written and sanitize when rendering. PO notes, supplier text and extracted text are untrusted wherever they are displayed. |
| ADR-0082 | Attachments: one polymorphic model, file type detected from the bytes against an allowlist (SVG/HTML rejected), served only from the API behind the parent record's permission, 25 MB per document, 5 GB total budget. **Not backed up** (accepted gap). |
| INVARIANTS INV-1/8, INV-SA-2/4 | Authorization comes from the database. Service accounts are fail-closed. Every audited row records the actor in exactly one of the human or service-account columns, enforced by a CHECK constraint. Any new PO log table must copy this pattern (`authorization.md` §7). |
| AI INV-AI-2/3/4 (`docs/ai-assistant/security.md:866-884`) | AI tools run through the same pipeline as the HTTP routes. A chat mutation needs a single-use human approval. **Stored content is data, never authority.** A supplier's PDF is untrusted content. |
| AI tool coverage | `apps/api/src/ai/core/tool-coverage.spec.ts` fails CI if **any** registered controller method is not decided in a toolset ("leaves no handler undecided"). Every new PO route needs an exposed or excluded decision. |
| Charter, upgrade safety | Additive, nullable or defaulted migrations; validation on write only; reads tolerate legacy data; new enum values must degrade gracefully; the PR body states what happens to existing data. |
| Charter, shared critical files | Would be touched: `packages/shared/src/index.ts`, `apps/api/src/app.module.ts`, `apps/web/components/sidebar-nav.tsx`, `apps/web/content/manual/_nav.ts`, `docs/03-decisions/_MOC.md`. These force units to run one after another. |

---

## 3. Building blocks

### 3.1 File and attachment storage (ADR-0082)

- **Exists:**
  - Model `Attachment` with `entityType` (`ASSET | ARTICLE`) and a soft `entityId` (`schema.prisma:3036-3081`).
  - Per-surface caps and allowlists (`apps/api/src/attachments/attachments.service.ts:59-70`).
  - Asset documents up to 25 MB (`packages/shared/src/schemas/attachment.ts:22,30`).
  - Total budget `ATTACHMENTS_MAX_TOTAL_MB`, default 5 GB (`attachments.constants.ts:29-35`).
  - Uploads streamed to disk (multer `diskStorage`), type detected from the bytes, and raster images re-encoded with sharp in a sandboxed worker.
  - Serving from the API only, with hardened headers; a daily cleanup sweep for orphaned files.
- **Extending to POs:** add a `PURCHASE_ORDER` value to `AttachmentEntityType` (the schema comment already plans for new types), a new `SURFACE` entry reusing the ASSET allowlist, and a controller guarded by `purchaseOrder:read/write`.
- **Gap:** the volume is **not backed up** (`docs/05-runbooks/backups.md:33, 83-92`). PO documents are financial evidence, which raises the stakes of that gap.
- **No antivirus scanning**, by decision (ADR-0082, alternatives section).

### 3.2 Making the feature optional

- **No general feature-flag mechanism exists.** `docs/ai-assistant/frontend.md:117-118` says so ("There is no general per-caller feature-flag endpoint"). `GET /config/status` is public.
- **Precedents for an OFF-by-default singleton settings row:**
  - `AssetTagScheme.enabled` (`schema.prisma:703`)
  - `SmtpSettings.enabled` (`:751`)
  - `AiSettings.enabled` (`:3106`)
  - `UpdateSettings`
- **Permission gating** already hides navigation entries (`apps/web/components/sidebar-nav.tsx:44-49, 231-246`), and admins can revoke reads per role in the role matrix (`authorization.md` §5).

### 3.3 AI assistant (ADR-0097, `docs/ai-assistant/`)

- **Providers:** Anthropic, OpenAI, Gemini, and OpenAI-compatible endpoints (`provider-and-runtime.md` §1). They are called through Vercel AI SDK `ai@^7` and `@ai-sdk/*` (`apps/api/package.json:29-44`).
- **Today the message contract is text only:**
  - `SendAiMessageSchema = { text, context? }` (`ai-run.ts:203-206`).
  - `userMessage(text)` builds `{ role: 'user', content: text }` (`aisdk-chat-model.ts:109-110`).
  - File and image attachments are listed as **not built in v1** (`_synthesis.md:670`; `frontend.md:907`), as are "file upload or download tools" (`_synthesis.md:679`).
  - The SDK's URL file-part download is blocked (`experimental_download` refuses, `provider-and-runtime.md:537-539`).
- **Provider support for files:** per the AI SDK docs (external, ai-sdk.dev/docs/foundations/prompts, fetched today), file parts with a `mediaType` work on Anthropic, OpenAI (PDF) and Google. OpenAI-compatible and local models (Ollama and similar) vary and mostly cannot read PDFs.
- **No structured-output call is used today.** There is no `generateObject`/`Output.object` anywhere in `apps/api/src`; only `streamText` in the chat model.
- **Existing machinery a PO feature can reuse:**
  - Batch write tools with one approval card (`asset_create_batch`, up to 200 rows).
  - `mutationWeight` counted against service-account caps (`assets.tools.ts:1220-1222`).
  - The `request_input` form tool, which covers "asks a few questions" (`input-request.tools.ts`; `AiInputRequestSchema` in `ai-run.ts:482`).
  - A page-context chip limited to one entity (`AiPageContextSchema`, `ai-run.ts:197-200`; entity vocabulary `AiEntityTypeSchema`, `ai-tools.ts:86`).
  - Untrusted-source markers that block auto-approval (`tool-descriptor.ts:83-86`; `security.md:835-842`).
  - A daily token budget per principal (`docs/02-domain/entities/ai-settings.md:74-75`).
- **MCP:** tools registered for MCP are also available to Claude Code. A Claude Code user can read the PDF locally and call a `purchase_order_create` tool, so extraction over MCP costs lazyit nothing.

### 3.4 Document extraction / OCR

**None.** `apps/api/package.json` has `mammoth` (docx), `multer` and `sharp` only. There is no `pdf-parse`, `pdfjs`, `unpdf` or `tesseract` in any package.json, and no hits in the source.

### 3.5 Bulk asset creation

- **`POST /assets/batch/receive`** (`asset:write`) loops `AssetsService.create()` per unit. Each unit is its own transaction with its own commit of the asset-tag counter, and the response is `{ created, failed[] }` partial success. This is **required** by the ADR-0063 counter design (ADR-0089 Context A1). Generating assets from a PO line has to reuse this loop.
- **Import** (`import-commit.service.ts`) uses the same per-row pattern.
- **AI `asset_create_batch`** is the chat equivalent.

---

## 4. Upgrade path over populated databases

### 4.1 What an additive migration looks like

1. **New tables only:** `suppliers`, `purchase_orders`, `purchase_order_lines`, `purchase_order_events`.
   - Partial unique indexes as raw SQL (ADR-0041).
   - Actor CHECK constraints as raw SQL (INV-SA-4).
   - Status columns as TEXT validated by zod, following the AI tables' precedent (`schema.prisma:3083-3091`), so a newer status degrades gracefully on an older build. Alternatively, Prisma enums appended at the tail.
2. **`ALTER TABLE assets ADD COLUMN "purchaseOrderLineId" text NULL`** with an FK (`ON DELETE RESTRICT`; soft delete never triggers it) and an index. Every existing row gets NULL, meaning "no PO", which is exactly today's behaviour.
3. **`ALTER TYPE "AttachmentEntityType" ADD VALUE 'PURCHASE_ORDER'`** and new `AssetHistoryEventType` values, appended (precedents: `ACKNOWLEDGED`, `AGENT_LINKED`, `CONSUMABLE_*`).
4. **Optional, for consumable lines:** a nullable `purchaseOrderLineId` on `consumable_movements`. That table is append-only, but adding a column that is set at insert time does not break that.
5. **No data step.** Permissions arrive through the seed-once ledger. The settings switch is a missing row that reads as OFF, as with AiSettings.

### 4.2 Coexistence options for asset purchase fields

| Option | Behaviour | Trade-offs |
| --- | --- | --- |
| **A. Asset fields stay authoritative; PO values are copied on generate or link (recommended)** | Generating from a line pre-fills `purchaseDate`, `purchaseCost` (= line unit price), `warrantyEnd` (if the line has warranty months) and the model. Linking an existing asset shows a field-by-field diff and the user chooses which fields to apply. Fields stay editable; if they diverge from the PO the UI shows "differs from PO". | Every current reader works unchanged: depreciation, warranty sweeper, dashboard, filters, CSV, import, clone, the AI tools and the reporting agent. Same pattern as copying model specs. Cost: the PO and the asset can drift apart, which is visible and intended. |
| B. Asset fields are derived from the PO line when linked (read-through, locked) | Asset columns are ignored or locked while linked. | Touches every reader listed above plus the shared schemas. Two sources of truth decided per row; unlinking has to rematerialise values. High blast radius and a read-path change over production data. |
| C. PO edits write through to linked assets | Changing a PO price rewrites N assets. | Silently mutates asset data, generates N `UPDATED` events per edit, and surprises operators. Breaks the "never overwrite without the human" expectation. |

### 4.3 Legacy data: optional backfill and linking

- **Nothing happens automatically.** Existing assets keep their values and get `purchaseOrderLineId = NULL`.
- **Manual "Link to PO"** from the asset applies values only through the option-A diff.
- **Phase-2 helper "Create PO from selected assets":** builds a PO with one line per model group and links the assets **without changing their fields**. Quantity is the asset count and unit price is shown, never written back.
- **Snipe-IT imports** may have put order numbers or suppliers into custom `specs` keys (assumption: I cannot see production data). The helper may *suggest* from those keys but never moves or deletes them.

### 4.4 What must never happen to existing data

- Overwriting or nulling any existing `Asset` purchase field during migration, or in a background job.
- Making any purchase field required, or requiring a PO to edit purchase data.
- Creating suppliers or POs heuristically in a migration.
- Deleting or rewriting `specs` keys.
- Rewriting `ConsumableMovement` rows.
- Unlinking assets when a PO is soft-deleted.

---

## 5. Data model options

### Option 1 — Thin PO: header + lines; assets point at a line (recommended)

**`Supplier`**
- `id` (cuid), `name` (partial-unique among live rows), `contactName?`, `email?`, `phone?`, `website?`, `notes?`, timestamps, `deletedAt`.
- Separate from manufacturer: Dell is the manufacturer, a reseller is the supplier. `Application.vendor` and `AssetModel.manufacturer` stay as they are.

**`PurchaseOrder`**
- `id`, `reference` (the PO or order number; free text), `supplierId?` (SetNull)
- `status`: `DRAFT | ORDERED | RECEIVED | CANCELLED`, set by the user
- `orderDate?`, `expectedDate?`, `receivedDate?`, `notes?`
- Optional header amounts in int4 minor units: `shippingCost?`, `taxAmount?`
- timestamps, `deletedAt`
- Partial unique on `(supplierId, reference)` among live rows.

**`PurchaseOrderLine`**
- `id`, `purchaseOrderId` (Restrict), `position`
- `kind`: `ASSET | OTHER` in the MVP; `CONSUMABLE | LICENSE` later
- `description`; `manufacturerText?` and `modelText?` (as written on the document)
- `assetModelId?` (SetNull; resolves the line to a model), `quantity` (`int4 ≥ 1`), `unitPrice` (`int4` minor units), `warrantyMonths?`
- timestamps, `deletedAt`

**`Asset.purchaseOrderLineId?`**
- N assets per line, at most one line per asset.
- The registered count is derived: the number of live assets linked to the line.

**`PurchaseOrderEvent`**
- Append-only: autoincrement `id`, `purchaseOrderId`, `eventType`, `payload`, a human or service-account actor with a CHECK constraint, `aiInvocationId?`, `createdAt`.
- Optionally added to the `recent_activity` view.

**Totals are derived and never stored**, computed in JS (safe up to about 9×10^15 minor units). This avoids the int4 overflow on PO totals.

**Partial receipt** means generating any subset of a line, at any time, through the bulk-receive loop. Two rules:
- An "at most `quantity`" check runs inside each unit's create transaction under a row lock on the line (`SELECT … FOR UPDATE`). The tag counter still commits separately, so the ADR-0063 invariant holds.
- Generating "none" is valid: `RECEIVED` is a status the user sets, separate from the derived "x of y registered".

**Trade-offs.**
- (+) Matches the request.
- (+) No change to how assets are read.
- (+) Reuses bulk receive, attachments, permissions and AI tools.
- (+) Small surface.
- (−) There is no record of "goods arrived but not yet registered as assets" beyond the coarse status.
- (−) The over-receipt check must live inside the shared create path.

### Option 2 — Option 1 plus a receipt ledger

Adds an append-only `PurchaseOrderReceipt`: `lineId`, `quantity`, `receivedAt`, actor. Assets and consumable `IN` movements optionally point at a receipt, and status is derived from received versus ordered.

**Trade-offs.**
- (+) Records partial deliveries with dates independently of asset creation.
- (+) Faithful goods-receipt history.
- (−) That history is what ADR-0089 explicitly declined ("NOT a goods-receipt ledger").
- (−) Two counters to reconcile (received and registered).
- (−) More UI and more AI tools.

It can be added on top of Option 1 later without remodelling.

### Option 3 — Two fields on the asset, with a PO page that groups assets

Adds `orderNumber?` and `supplier?` free-text columns to `Asset` (Snipe-IT style), plus a page that groups assets by `orderNumber`.

**Trade-offs.**
- (+) The smallest change; import aliases are trivial.
- (−) No line items, quantities, unit prices, document-level attachments or "generate from line".
- (−) Nothing for extraction to fill.
- (−) Fails the stated request.

**Recommendation: Option 1.** Add Option 2's ledger only if the user research shows that teams must record deliveries separately from registering the assets.

### Line → consumables / licenses

- **Consumable lines:** "Receive into stock" posts one `IN` `ConsumableMovement` (reason `PO <reference>`) carrying `purchaseOrderLineId`. The ledger stays the single place stock changes (ADR-0034).
- **License lines:** link to an `Application` for information only. **Do not** automatically change `Application.seatsPurchased`: it is a single mutable number, not a ledger (ADR-0088), so automatic arithmetic would double-count on re-edits.
- **Phasing:** both come after the MVP.

---

## 6. Recommended phasing

**Phase 0 — Decide and document** (documentation and backend lanes, serial because it touches `_MOC.md`)
- ADR-0099 "Purchase orders (scope, model, optionality)".
- Amend the non-goal line in ADR-0089 and the non-goals in `vision.md`.
- Entity notes in `docs/02-domain/entities/` (`supplier.md`, `purchase-order.md`, `purchase-order-line.md`, `purchase-order-event.md`).
- Updates to `asset.md`, `attachment.md`, `authorization.md`, and the backups runbook row.

**Phase 1 — MVP, manual entry**
- **Backend lane** (`apps/api/**`, `packages/shared/**`):
  - Migration (§4.1) and registration in `SOFT_DELETABLE_MODELS`.
  - Shared contracts `purchase-order.ts`, `supplier.ts`; `int4` everywhere; read schemas `.nullish()`.
  - Permission domain `purchaseOrder`.
  - Settings switch.
  - `PurchaseOrdersModule`: CRUD with a `Page<T>` list, line CRUD, restore, link/unlink asset, and `POST /purchase-orders/:id/lines/:lineId/generate-assets`. That endpoint wraps the receive loop, passes `purchaseOrderLineId`, applies the over-receipt guard and returns `{created, failed}`.
  - PO attachments controller.
  - Asset history events.
  - **Every new handler decided in the AI toolsets** (read tools exposed; writes deferred or excluded) so `tool-coverage.spec.ts` stays green.
  - Shared critical files (serial): the barrel and `app.module.ts`.
- **Frontend lane** (`apps/web/**`, including the Manual):
  - Navigation entry (`sidebar-nav.tsx`, critical), list/detail/form, line editor, supplier picker with create-inline.
  - "Generate assets" dialog with partial-success display, reusing the bulk-receiving UI.
  - Asset form/detail "Link to PO" with the apply-values diff and a provenance chip.
  - Settings switch card, permission labels (`messages/{en,es}/settings.json`), en/es catalogs.
  - **Manual** pages en+es, e.g. `assets-purchase-orders.md`, and `_nav.ts` (critical).
- **Contract:** the backend unit merges first; the frontend consumes the built `@lazyit/shared`.

**Phase 2 — Extraction from an uploaded document**
- **Backend:**
  - A new `ChatModel` port method `extractStructured(file, zodSchema)`. It sends a file part through the egress guard with **no tools**, uses structured output, and is counted against `dailyTokenLimitPerPrincipal`.
  - `POST /purchase-orders/extract { attachmentId }` returns a **draft**: header, lines, a match against existing suppliers and models, and per-field warnings. It **never saves anything**.
  - Disabled with a clear reason when AI is off or the provider and model cannot read files.
  - Also in this phase: consumable lines into `IN` movements, and the "Create PO from selected assets" helper.
- **Frontend:** "Upload PO → Extract" leads to a pre-filled form in review mode (unconfirmed fields highlighted, unmatched model or supplier gives a "create or choose" prompt), then the normal save path.

**Phase 3 — AI chat**
- **Backend:**
  - Tools `purchase_order_search/get`, `purchase_order_create/update` (write, approval card), `purchase_order_generate_assets` (`mutationWeight` = units), `supplier_*`.
  - `purchase_order_extract(attachmentId)`, which marks the document as an **untrusted source**, so no auto-approval for the rest of the conversation.
  - Add `purchaseOrder` to `AiEntityTypeSchema`.
- **Flow:** the user uploads on the PO page and opens the chat with that PO as page context. The model extracts, asks the open questions through `request_input`, then proposes the create as one approval card.
- **Chat file upload stays out of scope** (it would reverse `_synthesis.md:670`).
- **Frontend:** tool labels and sentences (en/es), the "Ask AI to fill" entry point, Manual `ai-assistant-*` updates.

---

## 7. Risks

1. **Scope creep into procurement** (approvals, budgets, invoices, 3-way match, supplier portals) against the IT-native positioning (`vision.md:24-33`). The ADR has to set hard limits.
2. **int4 money overflow** for currencies with large nominal amounts. Per-unit amounts already share the asset limit; header amounts (tax, shipping) are at risk; stored totals would overflow. Mitigation: derive totals in the app. A BigInt or Decimal type would be a second money convention, which ADR-0088 rejected.
3. **Attachments not backed up.** A disk loss loses every PO document while the PO rows survive with broken links.
4. **Extraction quality and trust.** Models can invent or misread values; cost and token use grow with page count; capability differs per provider (compatible and local models). Mitigation: draft only, human review, no tools during extraction.
5. **Prompt injection through supplier documents.** With no tools during extraction, the worst case is wrong field values. In chat, the untrusted marker forces per-action approval (INV-AI-4).
6. **Financial documents leave the instance** to the configured provider. The AI settings card has to disclose it, as is already done for web search (`security.md:827-831`).
7. **Over-receipt under concurrency.** Two users generating from the same line at once. Needs the lock or conditional check inside each unit's transaction; must be tested.
8. **Price visibility is inconsistent.** VIEWERs already see `Asset.purchaseCost`; restricting PO reads does not hide copied prices. There is no field-level authorization to fix this cheaply.
9. **Clone copies purchase fields** (`clone-defaults.ts:102-103`). A cloned asset must **not** inherit `purchaseOrderLineId`, or it would over-count the line.
10. **CI traps:**
    - `tool-coverage.spec.ts` (every handler decided).
    - Manual and message parity checks.
    - `SOFT_DELETABLE_MODELS` registration.
    - Serial edits to five shared critical files.
11. **Currency mismatch.** A foreign-currency PO copied into the single implicit currency silently misstates asset cost and depreciation.

---

## 8. Decisions for the CEO

1. **Bring POs into scope, reversing ADR-0089's non-goal.**
   - Options: (a) yes, with explicit limits; (b) no, keep using asset fields; (c) only Option 3's two fields.
   - **Recommendation: (a).** A new ADR-0099 states the limits: no approval workflow, budgets, invoices or 3-way match, and no supplier portal.
2. **Data model.**
   - Options: Option 1 (thin) / Option 2 (receipt ledger) / Option 3 (asset fields).
   - **Recommendation: Option 1.** The ledger only if the user research demands it.
3. **Supplier.**
   - Options: (a) a `Supplier` entity; (b) free text with autocomplete (ADR-0076 style); (c) merge with `Application.vendor` and `AssetModel.manufacturer`.
   - **Recommendation: (a).** POs are what create the need for rename and merge; keep it separate from manufacturer; leave existing vendor and manufacturer fields alone.
4. **Asset purchase fields alongside POs.**
   - Options: copy on generate/link with confirmation / derived / write-through.
   - **Recommendation: copy with confirmation.** Asset fields stay authoritative; divergence is visible, never silently overwritten.
5. **How to make it optional.**
   - Options: (a) usage only, always visible; (b) permissions only; (c) instance switch OFF by default, plus permissions.
   - **Recommendation: (c).** Matches the AI, tag-scheme and SMTP precedents. Turning it off hides the feature and never deletes data. Asset purchase fields stay editable in every mode.
6. **Who can see and edit POs.**
   - Options: same as assets (all roles read) / ADMIN+MEMBER / ADMIN-only.
   - **Recommendation:** `purchaseOrder:read` and `:write` for ADMIN and MEMBER, VIEWER denied (like `VIEWER_DENIED_READS`); `:delete` and restore ADMIN-only; grantable to service accounts. Accept that copied asset prices stay visible to VIEWERs (separate decision if not).
7. **Delete and cancel.**
   - Options: hard delete / soft delete that detaches assets / soft delete that keeps links / block delete while linked.
   - **Recommendation:** use the `CANCELLED` status for business cancellation. Soft delete is ADMIN-only, **keeps** asset links, and can be restored (ADR-0041). Unlinking an asset is allowed and audited. Never hard delete.
8. **Over-receipt.**
   - Options: block more generated assets than the line quantity / allow with a warning.
   - **Recommendation: block** (checked on write, under a lock). Line quantity can be raised.
9. **Money and currency.**
   - Options: (a) single implicit currency, int4 minor units, totals derived; (b) a currency code per PO, display only; (c) full multi-currency with exchange rates.
   - **Recommendation: (a) for the MVP.** Revisit after research. **Input needed:** which currencies do target instances use, and how often do they buy in foreign currency? Large-nominal currencies hit the int4 ceiling.
10. **PO number.**
    - Options: free text / unique per supplier / auto-numbered scheme (ADR-0063 style).
    - **Recommendation:** required free-text `reference`, unique among live POs per supplier; no auto-numbering in the MVP.
11. **Line kinds in the MVP.**
    - Options: assets only / assets and other / assets, consumables and licenses.
    - **Recommendation:** `ASSET` and `OTHER` (shipping, services) in the MVP. Consumable `IN` movements in phase 2. License lines link to an application for information only, never automatic seat arithmetic.
12. **Trust in AI extraction.**
    - Options: auto-create / draft plus human review / extraction suggests one field at a time.
    - **Recommendation: draft plus mandatory human review.** Extraction is a call with no tools; nothing is saved until the user saves; the document counts as untrusted, so no auto-approval in chat.
13. **Sending financial documents to the provider.**
    - Options: allow when AI is enabled with disclosure / a separate admin switch for document extraction / local OCR only.
    - **Recommendation: a separate OFF-by-default "Document extraction" switch under AI settings,** with disclosure, available only for providers and models that accept files. No local OCR: it is heavy and poor at structured data.
14. **File upload in chat.**
    - Options: add chat attachments (reverses synthesis §9.2) / chat works on a document already uploaded to the PO, via page context.
    - **Recommendation: the second.** Smaller, reuses the attachment security model, avoids re-sending the PDF on every turn and the extra conversation-retention work.
15. **Backup gap for PO documents.**
    - Options: ship with the existing accepted gap and a loud warning / raise the priority of the deferred attachments backup sidecar first.
    - **Recommendation: raise the sidecar's priority** so it lands before or alongside Phase 1. At minimum, a Manual warning on the PO page.
16. **Backfill of existing assets.**
    - Options: none / manual linking only / a helper that groups assets into a PO.
    - **Recommendation:** no automatic backfill. Manual "Link to PO" in Phase 1; the "Create PO from selected assets" helper (links only, never overwrites) in Phase 2.

---

## Assumptions

- Target instances use one dominant currency (the current code assumes so: `money.ts:6-7`).
- Legacy order or supplier data may sit in custom `specs` keys from Snipe-IT imports. I could not verify this without production data.
- A PO line maps to one `AssetModel`.
- An asset is acquired through at most one PO line.

## Not investigated

- **Production data shape:** no access.
- **Meilisearch indexing of POs** (ADR-0035): deferred, not needed for the MVP.
- **Web component internals** of the bulk-receiving dialog beyond its payload builder.
- **Live provider tests** of PDF and vision support for each configured model: only the AI SDK documentation was checked.
- **The parallel user-research track:** out of my scope; decisions 2, 9 and 11 depend on it.
- **ADR-0063 counter internals:** I relied on ADR-0089's account of them.

