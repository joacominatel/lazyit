/**
 * *Receive delivery* (ADR-0099 Phase 1b, UX proposal §6, #1497): one delivery received across several lines of
 * one purchase. Pure, so the sheet's rules are tested without React — which lines it offers, what each row
 * sends, and how the per-line outcomes read together.
 *
 * There is no new API: the sheet runs one request per line through the existing routes — `…/receive` for an
 * `ASSET` line (the same body the single *Receive units* dialog sends, built by `buildReceiveFromLinePayload`)
 * and `…/receive-stock` for a `CONSUMABLE` line. Each line is its own request, so the delivery can partly
 * succeed, and the result says, per line, what happened.
 */

import {
  ASSET_ATTACHMENT_MIME_TYPES,
  type AssetStatus,
  type PurchaseOrderDetail,
  type PurchaseOrderLine,
  RECEIVE_ASSETS_MAX_QUANTITY,
  type ReceiveFromLine,
  ReceiveFromLineSchema,
  type ReceiveStockFromLine,
  ReceiveStockFromLineSchema,
  warrantyEndFrom,
} from "@lazyit/shared";
import {
  buildReceiveFromLinePayload,
  lineReceivePrefill,
  parseSerials,
  type ReceiveDateSource,
} from "@/app/(app)/assets/_components/receive-stock-payload";
import { appendSerial } from "@/lib/utils/scanned-serials";

/** The kinds a delivery receives: assets and stock. License and other lines are never in the sheet. */
export type DeliveryKind = "ASSET" | "CONSUMABLE";

/** What the viewer may receive — `ASSET` needs `purchaseOrder:write` + `asset:write`, `CONSUMABLE` `+ consumable:write`. */
export interface DeliveryAccess {
  assets: boolean;
  stock: boolean;
}

/**
 * The delivery-note photo picker's `accept`: the images and PDF of the documents allowlist (ADR-0082 §3), so a
 * phone offers its camera, and a phone that shoots HEIC hands over a JPEG the allowlist takes.
 */
export const DELIVERY_NOTE_ACCEPT = ASSET_ATTACHMENT_MIME_TYPES.filter(
  (type) => type.startsWith("image/") || type === "application/pdf",
).join(",");

/** The highest count a stock receipt carries (the movement's int4 column). */
export const STOCK_RECEIVE_MAX_QUANTITY = 2_147_483_647;

/**
 * The lines of a purchase the sheet offers: `ASSET` lines when the viewer may receive assets, `CONSUMABLE`
 * lines when they may receive stock, each only while it still waits for units — the same rule as the
 * per-line *Receive* button. Purchase order is kept. License (applied, not received) and other lines never
 * appear, nor a kind a newer build writes.
 */
export function deliveryLines<L extends Pick<PurchaseOrderLine, "kind" | "pendingQuantity">>(
  lines: readonly L[],
  access: DeliveryAccess,
): L[] {
  return lines.filter(
    (line) =>
      line.pendingQuantity > 0 &&
      ((line.kind === "ASSET" && access.assets) || (line.kind === "CONSUMABLE" && access.stock)),
  );
}

/** One row of the sheet, as typed: the count stepped (or followed from the serials), the serials, the mapping. */
export interface DeliveryRow {
  /** The units stepped. Ignored for an asset row that has serials: the count follows them. */
  quantity: number;
  /** Serials, one per line (asset rows only). */
  serials: string;
  /** The model an unmapped asset line is received as — saved on the line first, as the single receive does. */
  modelId: string;
  /** The consumable an unmapped consumable line receives into — saved on the line first. */
  consumableId: string;
}

/** A row starts at zero: what arrived is counted at the door, never assumed (UX proposal §6). */
export function initialRow(line: Pick<PurchaseOrderLine, "assetModelId" | "consumableId">): DeliveryRow {
  return { quantity: 0, serials: "", modelId: line.assetModelId ?? "", consumableId: line.consumableId ?? "" };
}

/** The units a row receives: its serials when it has any (the count follows them), else the stepped count. */
export function rowQuantity(row: Pick<DeliveryRow, "quantity" | "serials">): number {
  const count = parseSerials(row.serials).length;
  return count > 0 ? count : row.quantity;
}

/** The most a row may step to, by kind (the receive route's bound for assets, int4 for stock). */
export function rowMax(kind: DeliveryKind): number {
  return kind === "ASSET" ? RECEIVE_ASSETS_MAX_QUANTITY : STOCK_RECEIVE_MAX_QUANTITY;
}

/** Step a row's count by `delta`, between 0 and the kind's bound. A row with serials follows them, not the stepper. */
export function stepRow(row: DeliveryRow, kind: DeliveryKind, delta: number): DeliveryRow {
  return setRowQuantity(row, kind, rowQuantity(row) + delta);
}

/** Set a row's count as typed (blank or not a whole number reads as 0), between 0 and the kind's bound. */
export function setRowQuantity(row: DeliveryRow, kind: DeliveryKind, value: number): DeliveryRow {
  const whole = Number.isFinite(value) ? Math.trunc(value) : 0;
  return { ...row, quantity: Math.min(Math.max(whole, 0), rowMax(kind)) };
}

/**
 * The serials box changed. Pasting or typing serials makes the count follow them; emptying the box keeps the
 * last count, so units without a serial can still be received.
 */
export function setRowSerials(row: DeliveryRow, serials: string): DeliveryRow {
  const count = parseSerials(serials).length;
  return { ...row, serials, quantity: count > 0 ? count : row.quantity };
}

/** One scanned serial, appended to the row it was scanned for; the count follows. */
export function addScannedSerial(row: DeliveryRow, code: string): DeliveryRow {
  return setRowSerials(row, appendSerial(row.serials, code));
}

/** The delivery values every asset unit shares, prefilled from the purchase. */
export interface DeliveryShared {
  /** `"YYYY-MM-DD"`, or blank for no purchase date. */
  purchaseDate: string;
  status: AssetStatus;
  /** A custom status (ADR-0101); blank = the bare `status`. */
  statusLabelId: string;
  /** Blank = no location. */
  locationId: string;
}

/**
 * The shared values a delivery starts with — the single receive's prefill (`lineReceivePrefill`): the
 * purchase's invoice date, else `today` (never the order date), status *In storage*, and the purchase's
 * delivery location.
 */
export function deliveryPrefill(
  purchase: Pick<PurchaseOrderDetail, "invoiceDate" | "deliveryLocationId">,
  today: string,
): { shared: DeliveryShared; dateSource: ReceiveDateSource } {
  return {
    shared: {
      purchaseDate: purchase.invoiceDate ? purchase.invoiceDate.slice(0, 10) : today,
      status: "IN_STORAGE",
      statusLabelId: "",
      locationId: purchase.deliveryLocationId ?? "",
    },
    dateSource: purchase.invoiceDate ? "INVOICE" : "TODAY",
  };
}

/** A line's receive, ready to send: the mapping to save on the line first (if any) and the body. */
export type DeliveryStep =
  | { kind: "ASSET"; line: PurchaseOrderLine; saveModelId: string | null; payload: ReceiveFromLine }
  | { kind: "CONSUMABLE"; line: PurchaseOrderLine; saveConsumableId: string | null; payload: ReceiveStockFromLine };

/** Why a row cannot be sent; shown on the row. */
export type DeliveryRowError = "modelRequired" | "consumableRequired" | "invalid";

/**
 * The delivery as requests — one step per row with a count above 0, in line order. Rows at 0 are skipped
 * (nothing arrived for them). For an asset row the body is exactly the single receive's: the line's prefill
 * (model, company, cost with its currency label) with the shared purchase date, status and location applied,
 * and the warranty end recomputed from the shared date and the line's warranty months — the same mapping the
 * prefill uses. The location is omitted while it is still the purchase's delivery location, so the API applies
 * the purchase's own value. A line with no model (or no consumable) needs one picked, which is saved on the
 * line first.
 *
 * `ok: false` with the rows to fix when any row cannot be sent, or `empty` when no row has a count.
 */
export function buildDeliveryPlan(input: {
  purchase: Pick<PurchaseOrderDetail, "invoiceDate" | "currency" | "company" | "deliveryLocationId">;
  lines: readonly PurchaseOrderLine[];
  rows: Readonly<Record<string, DeliveryRow>>;
  shared: DeliveryShared;
  today: string;
  locale: string;
}):
  | { ok: true; steps: DeliveryStep[] }
  | { ok: false; empty: boolean; errors: Record<string, DeliveryRowError> } {
  const { purchase, lines, rows, shared, today, locale } = input;
  const steps: DeliveryStep[] = [];
  const errors: Record<string, DeliveryRowError> = {};
  for (const line of lines) {
    const row = rows[line.id];
    if (!row) continue;
    const quantity = rowQuantity(row);
    if (quantity <= 0) continue;
    if (line.kind === "ASSET") {
      const modelId = line.assetModelId ?? row.modelId;
      if (!modelId) {
        errors[line.id] = "modelRequired";
        continue;
      }
      const { values } = lineReceivePrefill(purchase, line, today, locale);
      const warrantyEnd = shared.purchaseDate
        ? warrantyEndFrom(`${shared.purchaseDate}T00:00:00.000Z`, line.warrantyMonths)
        : null;
      const body = buildReceiveFromLinePayload(
        {
          ...values,
          modelId,
          quantity: String(row.quantity),
          serials: row.serials,
          status: shared.status,
          statusLabelId: shared.statusLabelId,
          locationId: shared.locationId,
          purchaseDate: shared.purchaseDate,
          warrantyEnd: warrantyEnd ? warrantyEnd.slice(0, 10) : "",
        },
        locale,
        { locationId: purchase.deliveryLocationId ?? "" },
      );
      const parsed = ReceiveFromLineSchema.safeParse(body);
      if (!parsed.success) {
        errors[line.id] = "invalid";
        continue;
      }
      steps.push({
        kind: "ASSET",
        line,
        saveModelId: line.assetModelId ? null : modelId,
        payload: parsed.data,
      });
    } else if (line.kind === "CONSUMABLE") {
      const consumableId = line.consumableId ?? row.consumableId;
      if (!consumableId) {
        errors[line.id] = "consumableRequired";
        continue;
      }
      const parsed = ReceiveStockFromLineSchema.safeParse({ quantity });
      if (!parsed.success) {
        errors[line.id] = "invalid";
        continue;
      }
      steps.push({
        kind: "CONSUMABLE",
        line,
        saveConsumableId: line.consumableId ? null : consumableId,
        payload: parsed.data,
      });
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, empty: false, errors };
  if (steps.length === 0) return { ok: false, empty: true, errors };
  return { ok: true, steps };
}

/** The units the submit button counts: every row's count, assets and stock together. */
export function deliveryUnits(rows: Readonly<Record<string, DeliveryRow>>, lineIds: readonly string[]): number {
  return lineIds.reduce((sum, id) => sum + (rows[id] ? rowQuantity(rows[id]) : 0), 0);
}

/** How one line's receive ended. */
export type DeliveryOutcome =
  | {
      lineId: string;
      kind: "ASSET";
      state: "received" | "partial" | "failed";
      created: number;
      failed: { index: number; error: string }[];
      overReceived: boolean;
    }
  | { lineId: string; kind: "CONSUMABLE"; state: "received"; created: number; overReceived: boolean }
  /** The request itself failed (or the mapping could not be saved): nothing was received on the line. */
  | { lineId: string; kind: DeliveryKind; state: "error"; message: string };

/** An asset receive's envelope as an outcome: every unit, some, or none created. */
export function assetOutcome(
  lineId: string,
  result: { created: readonly unknown[]; failed: { index: number; error: string }[]; overReceived: boolean },
): DeliveryOutcome {
  const created = result.created.length;
  const state = result.failed.length === 0 ? "received" : created > 0 ? "partial" : "failed";
  return { lineId, kind: "ASSET", state, created, failed: [...result.failed], overReceived: result.overReceived };
}

/** The delivery at a glance: units received, and the lines that need a look (some or all failed). */
export function summarizeDelivery(outcomes: readonly DeliveryOutcome[]): {
  units: number;
  linesReceived: number;
  linesWithProblems: number;
} {
  let units = 0;
  let linesReceived = 0;
  let linesWithProblems = 0;
  for (const outcome of outcomes) {
    if (outcome.state !== "error") units += outcome.created;
    if (outcome.state === "received") linesReceived += 1;
    else linesWithProblems += 1;
  }
  return { units, linesReceived, linesWithProblems };
}
