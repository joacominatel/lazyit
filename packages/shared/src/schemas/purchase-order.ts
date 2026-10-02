import { z } from "zod";
import { pageSchema } from "./pagination";
import { int4, money, optionalText, requireAtLeastOneKey } from "./primitives";

/**
 * Purchases (ADR-0099) — a purchase order, its lines and its append-only activity log. lazyit RECORDS
 * purchases; the finance system stays the system of record. Gated by the `purchaseOrder:*` permissions.
 * Single source of truth for api and web. See docs/02-domain/entities/purchase-order.md,
 * purchase-order-line.md and purchase-order-event.md.
 *
 * Three rules shape every schema here:
 *   - **Entry is light** (CEO decision D-D): a purchase needs only something that identifies it (a
 *     supplier, a reference or one line); a line needs only a description. Nothing is unique.
 *   - **Status, kind and event type are TEXT**, validated against the closed lists below ON WRITE and read
 *     as plain strings, so a value a newer build adds reads tolerantly on an older one (ADR-0099 §14).
 *   - **Money is never summed across currency labels.** Amounts are integer minor units (`money()`,
 *     ADR-0100); totals are derived per purchase and grouped by label (ADR-0099 §5).
 *
 * Date fields are ISO-8601 strings (wire shape) — see the note in asset-category.ts.
 */

/** The longest currency label accepted on write (purchase and asset alike): a label, not a sentence. */
export const CURRENCY_LABEL_MAX_LENGTH = 32;

/** An optional free-text currency label as a create accepts it — trimmed, blank = absent (ADR-0099 §5). */
export const currencyLabel = () => optionalText(CURRENCY_LABEL_MAX_LENGTH);

/** A currency label in a partial update: set it (trimmed, non-blank) or clear it with `null`. */
export const nullableCurrencyLabel = () =>
  z.string().trim().min(1).max(CURRENCY_LABEL_MAX_LENGTH).nullable();

/** The user-set purchase statuses. "Partially received" / "Received" are derived, never stored. */
export const PURCHASE_ORDER_STATUSES = ["DRAFT", "ORDERED", "CANCELLED"] as const;
/** WRITE validator for `PurchaseOrder.status`. Reads use a plain string (tolerant of newer values). */
export const PurchaseOrderStatusSchema = z.enum(PURCHASE_ORDER_STATUSES);
/** The status a purchase gets when the create omits it (ADR-0099 §3). */
export const DEFAULT_PURCHASE_ORDER_STATUS = "ORDERED";

/**
 * The line kinds this build writes. `ASSET` lines are received as assets; `OTHER` lines (shipping,
 * services, freebies) count in the total and are never pending. `CONSUMABLE` (Phase 1b) and `LICENSE`
 * (Phase 2) are appended later; a line of a kind this build does not know reads as not tracked.
 */
export const PURCHASE_ORDER_LINE_KINDS = ["ASSET", "OTHER"] as const;
/** WRITE validator for `PurchaseOrderLine.kind`. Reads use a plain string. */
export const PurchaseOrderLineKindSchema = z.enum(PURCHASE_ORDER_LINE_KINDS);
/** The kind a line gets when the create omits it. */
export const DEFAULT_PURCHASE_ORDER_LINE_KIND = "ASSET";

/**
 * The event types this build writes to the purchase activity log. Stored as TEXT (CTO decision under
 * D-D, ADR-0099), so a reader shows a type it does not know generically. Payloads (#1473):
 *   - `UNITS_RECEIVED`   { lineId, quantity, assetIds, failed, overReceived }
 *   - `UNITS_CANCELLED`  { lineId, quantity, cancelledQuantity: { from, to }, reason }
 *   - `ASSET_LINKED`     { lineId, assetIds, applied: { [assetId]: field[] }, moved, overReceived }
 *   - `ASSET_UNLINKED`   { lineId, assetIds } — or { lineId, assetIds, movedToPurchaseOrderId,
 *                        movedToLineId } on the purchase an asset was moved away from
 *   - `DOCUMENT_ADDED` / `DOCUMENT_REMOVED`  { attachmentId, originalName }
 */
export const PURCHASE_ORDER_EVENT_TYPES = [
  "CREATED",
  "UPDATED",
  "STATUS_CHANGED",
  "LINE_ADDED",
  "LINE_UPDATED",
  "LINE_REMOVED",
  "DELETED",
  "RESTORED",
  "UNITS_RECEIVED",
  "UNITS_CANCELLED",
  "ASSET_LINKED",
  "ASSET_UNLINKED",
  "DOCUMENT_ADDED",
  "DOCUMENT_REMOVED",
] as const;
export const PurchaseOrderEventTypeSchema = z.enum(PURCHASE_ORDER_EVENT_TYPES);

/**
 * The DERIVED receipt state of a countable line, or of a purchase over its countable lines:
 *   - `NONE`     — nothing received yet, units pending;
 *   - `PARTIAL`  — some received, some pending;
 *   - `RECEIVED` — nothing pending: received + cancelled reaches the quantity;
 *   - `OVER`     — more received than ordered (quantity − cancelled). Allowed and surfaced, never blocked
 *     (ADR-0099 §4).
 * A line that is not countable (`OTHER`, or a kind this build does not know) has no state (`null`).
 */
export const PURCHASE_ORDER_RECEIPT_STATES = ["NONE", "PARTIAL", "RECEIVED", "OVER"] as const;
export const PurchaseOrderReceiptStateSchema = z.enum(PURCHASE_ORDER_RECEIPT_STATES);

/**
 * The `receipt` filter of `GET /purchase-orders`: one derived state, or `PENDING` — at least one unit
 * still pending (state `NONE` or `PARTIAL`) on a purchase that is not `CANCELLED`.
 */
export const PurchaseOrderReceiptFilterSchema = z.enum([
  "PENDING",
  ...PURCHASE_ORDER_RECEIPT_STATES,
]);

/**
 * One derived total: the sum of `quantity × unitPrice` over the priced lines in ONE currency label.
 * Labels group trimmed and case-insensitively ("usd" and "USD " are one group); `currency: null` is the
 * "No currency" group. Lines without a price add nothing and are counted in `unpricedLines` so the UI can
 * say the total is partial. `amount` is `null` only when the sum would exceed `MONEY_MAX`.
 */
export const MoneyTotalSchema = z.object({
  currency: z.string().nullable(),
  amount: money().nullable(),
  unpricedLines: int4({ min: 0 }),
});

/**
 * Receipt counters of a purchase over its countable lines (`null` on a purchase with none). `state` is
 * `RECEIVED` — or `OVER` when some line received more than it expected — once nothing is pending on any
 * countable line, `NONE` while nothing arrived, `PARTIAL` otherwise.
 */
export const PurchaseOrderReceiptSchema = z.object({
  state: PurchaseOrderReceiptStateSchema,
  ordered: int4({ min: 0 }),
  received: int4({ min: 0 }),
  cancelled: int4({ min: 0 }),
  pending: int4({ min: 0 }),
});

/** A purchase line as read, with its derived receipt counters. */
export const PurchaseOrderLineSchema = z.object({
  id: z.cuid(),
  purchaseOrderId: z.cuid(),
  position: int4({ min: 0 }),
  // TEXT: a kind written by a newer build reads as a plain string.
  kind: z.string(),
  description: z.string(),
  manufacturerText: z.string().nullable(),
  modelText: z.string().nullable(),
  assetModelId: z.cuid().nullable(),
  quantity: int4({ min: 0 }),
  unitPrice: money().nullable(),
  cancelledQuantity: int4({ min: 0 }),
  warrantyMonths: int4({ min: 0 }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  // ── Derived, never stored ──
  /** Live assets linked to this line. */
  receivedQuantity: int4({ min: 0 }),
  /** quantity − received − cancelled, floored at 0; always 0 on a line that is not countable. */
  pendingQuantity: int4({ min: 0 }),
  receiptState: PurchaseOrderReceiptStateSchema.nullable(),
  /** quantity × unitPrice; `null` when the price is unknown (or the product exceeds MONEY_MAX). */
  lineTotal: money().nullable(),
});

/** The purchase row itself (API representation of the `purchase_orders` row). */
export const PurchaseOrderSchema = z.object({
  id: z.cuid(),
  reference: z.string().nullable(),
  supplierId: z.cuid().nullable(),
  // TEXT: a status written by a newer build reads as a plain string.
  status: z.string(),
  currency: z.string().nullable(),
  orderDate: z.iso.datetime().nullable(),
  expectedDate: z.iso.datetime().nullable(),
  deliveryLocationId: z.cuid().nullable(),
  company: z.string().nullable(),
  invoiceNumbers: z.string().nullable(),
  invoiceDate: z.iso.datetime().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** The supplier as embedded on a purchase read. `deletedAt` set = an archived supplier, still shown. */
export const PurchaseOrderSupplierRefSchema = z.object({
  id: z.cuid(),
  name: z.string(),
  deletedAt: z.iso.datetime().nullable(),
});

/** One row of `GET /purchase-orders`: the purchase plus its supplier, line count, receipt and totals. */
export const PurchaseOrderListItemSchema = PurchaseOrderSchema.extend({
  supplier: PurchaseOrderSupplierRefSchema.nullable(),
  lineCount: int4({ min: 0 }),
  receipt: PurchaseOrderReceiptSchema.nullable(),
  totals: z.array(MoneyTotalSchema),
});

/** `GET /purchase-orders/:id`: the list item plus its live lines in display order. */
export const PurchaseOrderDetailSchema = PurchaseOrderListItemSchema.extend({
  lines: z.array(PurchaseOrderLineSchema),
});

/** The paginated `GET /purchase-orders` envelope (ADR-0030). */
export const PurchaseOrderListPageSchema = pageSchema(PurchaseOrderListItemSchema);

/** One activity-log row. `eventType` and `payload` are read tolerantly (TEXT + unvalidated jsonb). */
export const PurchaseOrderEventSchema = z.object({
  id: int4({ min: 1 }),
  purchaseOrderId: z.cuid(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  performedById: z.uuid().nullable(),
  serviceAccountId: z.string().nullable(),
  aiInvocationId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/** The paginated `GET /purchase-orders/:id/events` envelope, newest first. */
export const PurchaseOrderEventPageSchema = pageSchema(PurchaseOrderEventSchema);

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────

/** A line quantity: at least one unit. */
const lineQuantity = () => int4({ min: 1, example: 1 });
/** A count of cancelled units. */
const cancelledQuantity = () => int4({ min: 0, example: 0 });
/** Warranty months on a received unit (up to 100 years). */
const warrantyMonths = () => int4({ min: 0, max: 1200, example: 12 });

/**
 * A line as a create accepts it — inline on `POST /purchase-orders` or on its own on
 * `POST /purchase-orders/:id/lines`. Only `description` is required: `kind` defaults to `ASSET`,
 * `quantity` to 1, `cancelledQuantity` to 0, and `position` to after the last line. `unitPrice` absent or
 * `null` = unknown; `0` = free.
 */
export const CreatePurchaseOrderLineSchema = z
  .strictObject({
    kind: PurchaseOrderLineKindSchema.optional(),
    description: z.string().trim().min(1).max(500),
    manufacturerText: optionalText(200),
    modelText: optionalText(200),
    assetModelId: z.cuid().optional(),
    quantity: lineQuantity().optional(),
    unitPrice: money().nullish(),
    cancelledQuantity: cancelledQuantity().optional(),
    warrantyMonths: warrantyMonths().optional(),
    position: int4({ min: 0 }).optional(),
  })
  .refine((line) => (line.cancelledQuantity ?? 0) <= (line.quantity ?? 1), {
    error: "cancelledQuantity cannot exceed quantity",
    path: ["cancelledQuantity"],
  });

/**
 * Partial line update (an empty body is rejected). Optional fields accept `null` to clear them. The
 * cancelled ≤ quantity rule is checked by the API against the stored line, since a PATCH may carry only
 * one of the two.
 */
export const UpdatePurchaseOrderLineSchema = requireAtLeastOneKey(
  z
    .strictObject({
      kind: PurchaseOrderLineKindSchema,
      description: z.string().trim().min(1).max(500),
      manufacturerText: z.string().trim().min(1).max(200).nullable(),
      modelText: z.string().trim().min(1).max(200).nullable(),
      assetModelId: z.cuid().nullable(),
      quantity: lineQuantity(),
      unitPrice: money().nullable(),
      cancelledQuantity: cancelledQuantity(),
      warrantyMonths: warrantyMonths().nullable(),
      position: int4({ min: 0 }),
    })
    .partial(),
);

/** The most lines one create may carry inline. */
export const PURCHASE_ORDER_MAX_INLINE_LINES = 500;

/**
 * Payload to create a purchase. No single field is required, but the purchase must be identifiable: a
 * `supplierId`, a `reference`, or at least one line (ADR-0099 §2, CEO decision D-D). `status` defaults to
 * `ORDERED`. Nothing is unique — the same reference twice is accepted.
 */
export const CreatePurchaseOrderSchema = z
  .strictObject({
    supplierId: z.cuid().optional(),
    reference: optionalText(200),
    status: PurchaseOrderStatusSchema.optional(),
    currency: currencyLabel(),
    orderDate: z.iso.datetime().optional(),
    expectedDate: z.iso.datetime().optional(),
    deliveryLocationId: z.cuid().optional(),
    company: optionalText(200),
    invoiceNumbers: optionalText(500),
    invoiceDate: z.iso.datetime().optional(),
    notes: optionalText(5000),
    lines: z.array(CreatePurchaseOrderLineSchema).max(PURCHASE_ORDER_MAX_INLINE_LINES).optional(),
  })
  .refine(
    (po) =>
      po.supplierId !== undefined ||
      po.reference !== undefined ||
      (po.lines !== undefined && po.lines.length > 0),
    {
      error: "A purchase needs a supplier, a reference or at least one line",
      path: ["reference"],
    },
  );

/**
 * Partial header update (an empty body is rejected). Optional fields accept `null` to clear them; the API
 * refuses a change that would leave the purchase with no supplier, no reference and no line. Lines change
 * through their own endpoints.
 */
export const UpdatePurchaseOrderSchema = requireAtLeastOneKey(
  z
    .strictObject({
      supplierId: z.cuid().nullable(),
      reference: z.string().trim().min(1).max(200).nullable(),
      status: PurchaseOrderStatusSchema,
      currency: nullableCurrencyLabel(),
      orderDate: z.iso.datetime().nullable(),
      expectedDate: z.iso.datetime().nullable(),
      deliveryLocationId: z.cuid().nullable(),
      company: z.string().trim().min(1).max(200).nullable(),
      invoiceNumbers: z.string().trim().min(1).max(500).nullable(),
      invoiceDate: z.iso.datetime().nullable(),
      notes: z.string().trim().min(1).max(5000).nullable(),
    })
    .partial(),
);

export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatusSchema>;
export type PurchaseOrderLineKind = z.infer<typeof PurchaseOrderLineKindSchema>;
export type PurchaseOrderEventType = z.infer<typeof PurchaseOrderEventTypeSchema>;
export type PurchaseOrderReceiptState = z.infer<typeof PurchaseOrderReceiptStateSchema>;
export type PurchaseOrderReceiptFilter = z.infer<typeof PurchaseOrderReceiptFilterSchema>;
export type MoneyTotal = z.infer<typeof MoneyTotalSchema>;
export type PurchaseOrderReceipt = z.infer<typeof PurchaseOrderReceiptSchema>;
export type PurchaseOrderLine = z.infer<typeof PurchaseOrderLineSchema>;
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;
export type PurchaseOrderSupplierRef = z.infer<typeof PurchaseOrderSupplierRefSchema>;
export type PurchaseOrderListItem = z.infer<typeof PurchaseOrderListItemSchema>;
export type PurchaseOrderDetail = z.infer<typeof PurchaseOrderDetailSchema>;
export type PurchaseOrderListPage = z.infer<typeof PurchaseOrderListPageSchema>;
export type PurchaseOrderEvent = z.infer<typeof PurchaseOrderEventSchema>;
export type PurchaseOrderEventPage = z.infer<typeof PurchaseOrderEventPageSchema>;
export type CreatePurchaseOrderLine = z.infer<typeof CreatePurchaseOrderLineSchema>;
export type UpdatePurchaseOrderLine = z.infer<typeof UpdatePurchaseOrderLineSchema>;
export type CreatePurchaseOrder = z.infer<typeof CreatePurchaseOrderSchema>;
export type UpdatePurchaseOrder = z.infer<typeof UpdatePurchaseOrderSchema>;
