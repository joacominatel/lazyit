import { z } from "zod";
import { AssetSchema, AssetStatusSchema } from "./asset";
import { AttachmentSchema } from "./attachment";
import { MAX_BATCH_IDS } from "./batch";
import { pageSchema } from "./pagination";
import { int4, money, optionalText } from "./primitives";
import {
  CURRENCY_LABEL_MAX_LENGTH,
  PurchaseOrderLineSchema,
  PurchaseOrderSupplierRefSchema,
} from "./purchase-order";
import { RECEIVE_ASSETS_MAX_QUANTITY } from "./asset-receive";

/**
 * Purchases flows (ADR-0099, #1473): receiving units from a line, linking existing assets to it (with the
 * per-field "apply values" confirmation), cancelling remaining units, the pending-units list and an asset's
 * purchase provenance. Single source of truth for api and web. See docs/02-domain/entities/
 * purchase-order-line.md (receiving, linking, the apply mapping) and asset.md (provenance).
 *
 * Asset purchase fields stay AUTHORITATIVE: a value from the purchase reaches an asset only for the fields the
 * caller lists (ADR-0099 §2, "copy on confirm"). Over-receipt is allowed and flagged, never refused (§4).
 */

// ── Apply values ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The asset fields a link may copy from the purchase. `purchaseCost` carries `purchaseCurrency` with it —
 * cost and its currency always move together (ADR-0099 §2). The mapping (docs: purchase-order-line.md):
 *   - `purchaseDate`  ← the purchase's invoice date, else its order date;
 *   - `purchaseCost`  ← the line's unit price, with the purchase's currency label;
 *   - `warrantyEnd`   ← that purchase date + the line's warranty months;
 *   - `company`       ← the purchase's company;
 *   - `modelId`       ← the line's asset model.
 */
export const PURCHASE_APPLY_FIELDS = [
  "purchaseDate",
  "purchaseCost",
  "warrantyEnd",
  "company",
  "modelId",
] as const;
export const PurchaseApplyFieldSchema = z.enum(PURCHASE_APPLY_FIELDS);

/**
 * What applying one field would do to one asset:
 *   - `FILL`        — the asset has no value and the purchase has one (the UI pre-checks it);
 *   - `REPLACE`     — the asset holds a different value (never pre-checked);
 *   - `SAME`        — nothing would change (cost: same amount and same label, trimmed and case-insensitive);
 *   - `UNAVAILABLE` — the purchase has no value for it; applying it is a no-op, never a clear.
 */
export const PURCHASE_APPLY_ACTIONS = ["FILL", "REPLACE", "SAME", "UNAVAILABLE"] as const;
export const PurchaseApplyActionSchema = z.enum(PURCHASE_APPLY_ACTIONS);

/** A cost as the diff compares it: the amount (minor units) with its currency label. */
export const PurchaseCostValueSchema = z.object({
  amount: money().nullable(),
  currency: z.string().nullable(),
});

/** One field of the diff: the asset's value, the purchase's value, and what applying it would do. */
const fieldDiff = <T extends z.ZodType>(value: T) =>
  z.object({
    current: value.nullable(),
    purchase: value.nullable(),
    action: PurchaseApplyActionSchema,
  });

/** Where the purchase date offered to assets comes from: the invoice date, else the order date. */
export const PurchaseDateSourceSchema = z.enum(["INVOICE", "ORDER"]);

/** The values a line offers to its assets — what `apply` copies (null = nothing to offer). */
export const PurchaseLineValuesSchema = z.object({
  purchaseDate: z.iso.datetime().nullable(),
  purchaseDateSource: PurchaseDateSourceSchema.nullable(),
  purchaseCost: PurchaseCostValueSchema.nullable(),
  warrantyEnd: z.iso.datetime().nullable(),
  company: z.string().nullable(),
  modelId: z.cuid().nullable(),
});

/** Whether an asset is linked: to no purchase, to this line already, or to another line. */
export const PurchaseLinkStateSchema = z.enum(["NONE", "THIS_LINE", "OTHER_LINE"]);

/** One asset of the link preview, with its per-field diff against the line. */
export const PurchaseLinkPreviewAssetSchema = z.object({
  assetId: z.cuid(),
  name: z.string(),
  assetTag: z.string().nullable(),
  linkState: PurchaseLinkStateSchema,
  /** The line (and its purchase) the asset is linked to now; `null` when not linked. */
  linkedLineId: z.cuid().nullable(),
  linkedPurchaseOrderId: z.cuid().nullable(),
  fields: z.object({
    purchaseDate: fieldDiff(z.iso.datetime()),
    purchaseCost: z.object({
      current: PurchaseCostValueSchema,
      purchase: PurchaseCostValueSchema.nullable(),
      action: PurchaseApplyActionSchema,
    }),
    warrantyEnd: fieldDiff(z.iso.datetime()),
    company: fieldDiff(z.string()),
    modelId: fieldDiff(z.cuid()),
  }),
});

/** At most this many assets per link, unlink or preview request (the batch-ids cap). */
export const PURCHASE_LINK_MAX_ASSETS = MAX_BATCH_IDS;

/** A non-empty, de-duplicated, bounded list of asset ids. */
const assetIds = () =>
  z
    .array(z.cuid())
    .min(1)
    .max(PURCHASE_LINK_MAX_ASSETS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "assetIds must be unique (no duplicates)",
    });

/** `POST /purchase-orders/:id/lines/:lineId/link-preview` — a read with a body (the ids may be many). */
export const PurchaseLinkPreviewRequestSchema = z.strictObject({ assetIds: assetIds() });

/**
 * The link preview: the values the line offers, each asset's diff, and what the line would read once the
 * not-yet-linked assets are linked. `missing` lists ids that are not live assets.
 */
export const PurchaseLinkPreviewSchema = z.object({
  line: PurchaseOrderLineSchema,
  values: PurchaseLineValuesSchema,
  assets: z.array(PurchaseLinkPreviewAssetSchema),
  missing: z.array(z.string()),
  /** Received on the line after linking every listed asset that is not on it yet (moves included). */
  receivedAfter: int4({ min: 0 }),
  /** Whether that would leave the line over-received — a warning, never a refusal (ADR-0099 §4). */
  overReceivedAfter: z.boolean(),
});

/**
 * `POST /purchase-orders/:id/lines/:lineId/link-assets`. `apply` lists the fields copied onto EVERY asset
 * (where the purchase has a value — a fill or a replace alike); `applyByAsset` overrides that list for the
 * assets it names (the per-cell choice). A field nobody lists is never touched. An asset already linked to
 * another line is moved only with `move: true`; otherwise it fails with `LINKED_ELSEWHERE`.
 */
export const LinkAssetsToLineSchema = z.strictObject({
  assetIds: assetIds(),
  apply: z.array(PurchaseApplyFieldSchema).max(PURCHASE_APPLY_FIELDS.length).optional(),
  applyByAsset: z
    .record(z.cuid(), z.array(PurchaseApplyFieldSchema).max(PURCHASE_APPLY_FIELDS.length))
    .optional(),
  move: z.boolean().optional(),
});

/** Why one asset of a link or unlink request was not changed. */
export const PURCHASE_LINK_FAILURE_REASONS = [
  "NOT_FOUND",
  "ALREADY_LINKED",
  "LINKED_ELSEWHERE",
  "NOT_LINKED",
] as const;
export const PurchaseLinkFailureReasonSchema = z.enum(PURCHASE_LINK_FAILURE_REASONS);

const linkFailure = z.object({
  assetId: z.string(),
  reason: PurchaseLinkFailureReasonSchema,
  error: z.string(),
});

/** The link result: partial success, like bulk receive. `line` is the line as it reads afterwards. */
export const LinkAssetsResultSchema = z.object({
  linked: z.array(AssetSchema),
  failed: z.array(linkFailure),
  overReceived: z.boolean(),
  line: PurchaseOrderLineSchema,
});

/** `POST /purchase-orders/:id/lines/:lineId/unlink-assets` — one or many. Values are never cleared. */
export const UnlinkAssetsFromLineSchema = z.strictObject({ assetIds: assetIds() });

export const UnlinkAssetsResultSchema = z.object({
  unlinked: z.array(AssetSchema),
  failed: z.array(linkFailure),
  line: PurchaseOrderLineSchema,
});

// ── Receive from a line ───────────────────────────────────────────────────────────────────────────────

/**
 * `POST /purchase-orders/:id/lines/:lineId/receive` — generate assets from an `ASSET` line through the
 * bulk-receive loop (each unit its own transaction and tag-counter commit, ADR-0089/0063). Everything is
 * prefilled from the purchase; every field here is an OVERRIDE for this receive only (`null` = leave it
 * empty on the units):
 *   - model ← the line's asset model (required: a line with none needs `modelId` here, else 400);
 *   - status ← `IN_STORAGE`; location ← the purchase's delivery location; company ← the purchase's;
 *   - purchase date ← the invoice date, else today; warranty end ← that date + the line's warranty months;
 *   - cost ← the line's unit price, with the purchase's currency label.
 * `quantity` defaults to the serials given, else to every pending unit. Receiving past the pending count is
 * allowed and flagged (`overReceived`).
 */
export const ReceiveFromLineSchema = z
  .strictObject({
    quantity: int4({ min: 1, max: RECEIVE_ASSETS_MAX_QUANTITY }).optional(),
    serials: z.array(z.string().trim().min(1).max(200)).max(RECEIVE_ASSETS_MAX_QUANTITY).optional(),
    status: AssetStatusSchema.optional(),
    modelId: z.cuid().optional(),
    locationId: z.cuid().nullable().optional(),
    company: z.string().trim().min(1).max(200).nullable().optional(),
    purchaseDate: z.iso.datetime().nullable().optional(),
    warrantyEnd: z.iso.datetime().nullable().optional(),
    purchaseCost: money().nullable().optional(),
    purchaseCurrency: z.string().trim().min(1).max(CURRENCY_LABEL_MAX_LENGTH).nullable().optional(),
    notes: optionalText(2000),
  })
  .refine(
    (v) =>
      v.serials === undefined ||
      v.serials.length === 0 ||
      v.quantity === undefined ||
      v.serials.length === v.quantity,
    { message: "serials must be empty or contain exactly `quantity` entries", path: ["serials"] },
  );

/** The receive-from-line result: bulk receive's envelope, the over-receipt flag and the line afterwards. */
export const ReceiveFromLineResultSchema = z.object({
  created: z.array(AssetSchema),
  failed: z.array(z.object({ index: z.number().int().min(0), error: z.string() })),
  overReceived: z.boolean(),
  line: PurchaseOrderLineSchema,
});

// ── Cancel remaining units ────────────────────────────────────────────────────────────────────────────

/**
 * `POST /purchase-orders/:id/lines/:lineId/cancel-remaining` — cancel units that will not arrive. `quantity`
 * defaults to every pending unit and may not exceed them; the optional reason goes to the activity log.
 */
export const CancelRemainingUnitsSchema = z.strictObject({
  quantity: int4({ min: 1 }).optional(),
  reason: optionalText(500),
});

// ── Pending units ─────────────────────────────────────────────────────────────────────────────────────

/** The purchase header a pending line carries. */
export const PendingLinePurchaseSchema = z.object({
  id: z.cuid(),
  reference: z.string().nullable(),
  status: z.string(),
  currency: z.string().nullable(),
  orderDate: z.iso.datetime().nullable(),
  expectedDate: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  supplier: PurchaseOrderSupplierRefSchema.nullable(),
});

/**
 * One row of `GET /purchase-orders/pending-lines`: a countable line with units still pending, on a live
 * purchase that is neither `DRAFT` nor `CANCELLED`. Oldest purchase first.
 */
export const PendingPurchaseLineSchema = PurchaseOrderLineSchema.extend({
  purchaseOrder: PendingLinePurchaseSchema,
});

export const PendingPurchaseLinePageSchema = pageSchema(PendingPurchaseLineSchema);

// ── An asset's purchase provenance ────────────────────────────────────────────────────────────────────

/** The supplier as an asset's provenance shows it — with the support / RMA contact (warranty claims). */
export const ProvenanceSupplierSchema = z.object({
  id: z.cuid(),
  name: z.string(),
  website: z.string().nullable(),
  supportContactName: z.string().nullable(),
  supportContactEmail: z.string().nullable(),
  supportContactPhone: z.string().nullable(),
  deletedAt: z.iso.datetime().nullable(),
});

/**
 * `GET /assets/:id/purchase` — the asset's *Purchase* panel (ADR-0099 §8, CEO decision D-A): served only to
 * a principal holding `purchaseOrder:read` (403 otherwise), 404 when the asset is not linked. An archived
 * purchase is still the asset's provenance (`deletedAt` set); its documents are listed only while it is live
 * (download through `/purchase-orders/:id/attachments/:attachmentId/content`, same permission).
 */
export const AssetPurchaseProvenanceSchema = z.object({
  line: PurchaseOrderLineSchema,
  purchaseOrder: z.object({
    id: z.cuid(),
    reference: z.string().nullable(),
    status: z.string(),
    currency: z.string().nullable(),
    orderDate: z.iso.datetime().nullable(),
    expectedDate: z.iso.datetime().nullable(),
    company: z.string().nullable(),
    invoiceNumbers: z.string().nullable(),
    invoiceDate: z.iso.datetime().nullable(),
    deletedAt: z.iso.datetime().nullable(),
    supplier: ProvenanceSupplierSchema.nullable(),
  }),
  documents: z.array(AttachmentSchema),
});

export type PurchaseApplyField = z.infer<typeof PurchaseApplyFieldSchema>;
export type PurchaseApplyAction = z.infer<typeof PurchaseApplyActionSchema>;
export type PurchaseCostValue = z.infer<typeof PurchaseCostValueSchema>;
export type PurchaseDateSource = z.infer<typeof PurchaseDateSourceSchema>;
export type PurchaseLineValues = z.infer<typeof PurchaseLineValuesSchema>;
export type PurchaseLinkState = z.infer<typeof PurchaseLinkStateSchema>;
export type PurchaseLinkPreviewAsset = z.infer<typeof PurchaseLinkPreviewAssetSchema>;
export type PurchaseLinkPreviewRequest = z.infer<typeof PurchaseLinkPreviewRequestSchema>;
export type PurchaseLinkPreview = z.infer<typeof PurchaseLinkPreviewSchema>;
export type LinkAssetsToLine = z.infer<typeof LinkAssetsToLineSchema>;
export type PurchaseLinkFailureReason = z.infer<typeof PurchaseLinkFailureReasonSchema>;
export type LinkAssetsResult = z.infer<typeof LinkAssetsResultSchema>;
export type UnlinkAssetsFromLine = z.infer<typeof UnlinkAssetsFromLineSchema>;
export type UnlinkAssetsResult = z.infer<typeof UnlinkAssetsResultSchema>;
export type ReceiveFromLine = z.infer<typeof ReceiveFromLineSchema>;
export type ReceiveFromLineResult = z.infer<typeof ReceiveFromLineResultSchema>;
export type CancelRemainingUnits = z.infer<typeof CancelRemainingUnitsSchema>;
export type PendingPurchaseLine = z.infer<typeof PendingPurchaseLineSchema>;
export type PendingPurchaseLinePage = z.infer<typeof PendingPurchaseLinePageSchema>;
export type AssetPurchaseProvenance = z.infer<typeof AssetPurchaseProvenanceSchema>;
