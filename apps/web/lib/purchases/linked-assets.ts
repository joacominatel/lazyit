/**
 * Listing assets by purchase (ADR-0099, #1476) — pure. `GET /assets` filters by purchase line, purchase or
 * "linked / not linked", but only for a caller holding `purchaseOrder:read`: the filter itself reveals
 * provenance (D-A), and the API refuses it (403) otherwise. These helpers are the one place the web builds
 * those filters, and they never produce one for a viewer without the permission.
 */

import type { AssetFilters, PurchaseAssetFilter } from "@/lib/api/endpoints/assets";

/** The purchase filter to send, or `undefined` — always `undefined` without `purchaseOrder:read`. */
export function purchaseAssetFilter(
  canReadPurchases: boolean,
  filter: PurchaseAssetFilter,
): PurchaseAssetFilter | undefined {
  return canReadPurchases ? filter : undefined;
}

/** How many of a line's assets the purchase page lists at once. */
export const LINE_ASSETS_LIMIT = 50;

/**
 * The read behind a line's linked-assets list: the live assets on that line, oldest first so the order
 * matches receiving. `null` — no request at all — without `purchaseOrder:read`.
 */
export function lineAssetsFilters(lineId: string, canReadPurchases: boolean): AssetFilters | null {
  const purchase = purchaseAssetFilter(canReadPurchases, { purchaseOrderLineId: lineId });
  if (!purchase) return null;
  return { purchase, sort: "createdAt", dir: "asc", limit: LINE_ASSETS_LIMIT };
}

/**
 * The link picker's read (UX proposal §3.e): the search, the line's model when that chip is on, and "not
 * linked to a purchase" when that chip is on — which only a viewer with `purchaseOrder:read` gets.
 */
export function linkPickerFilters({
  q,
  modelId,
  notLinked,
  canReadPurchases,
  window = null,
}: {
  q: string;
  modelId: string | null;
  notLinked: boolean;
  canReadPurchases: boolean;
  /** The "near the order date" chip's window (#1503), when the chip is on. */
  window?: AcquiredWindow | null;
}): AssetFilters {
  const purchase = notLinked ? purchaseAssetFilter(canReadPurchases, { purchaseLinked: false }) : undefined;
  return {
    q: q || undefined,
    modelId: modelId ?? undefined,
    ...(purchase ? { purchase } : {}),
    ...(window ? { acquiredFrom: window.from, acquiredTo: window.to } : {}),
    limit: 50,
  };
}

/** How far either side of the purchase's date the link picker looks by default (UX proposal §3.e). */
export const NEAR_ORDER_DAYS = 90;

/** An acquisition window, as full ISO datetimes, both inclusive. */
export interface AcquiredWindow {
  /** The day the window is centred on (`YYYY-MM-DD`, UTC) — what the chip names. */
  anchor: string;
  from: string;
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The link picker's "near the order date" window (#1503; CEO decision on #1495): ±{@link NEAR_ORDER_DAYS}
 * days around the purchase's order date — else its invoice date, else the day it was recorded — from the
 * start of the first day to the last millisecond of the last one, in UTC (dates are stored at UTC midnight).
 * The API matches it against each asset's purchase date, else the day the asset was recorded. `null` when
 * the purchase carries no usable date.
 */
export function nearOrderWindow(
  purchase: { orderDate: string | null; invoiceDate?: string | null; createdAt: string | null },
  days: number = NEAR_ORDER_DAYS,
): AcquiredWindow | null {
  const source = purchase.orderDate ?? purchase.invoiceDate ?? purchase.createdAt;
  if (!source) return null;
  const at = new Date(source).getTime();
  if (Number.isNaN(at)) return null;
  const day = Math.floor(at / DAY_MS) * DAY_MS;
  return {
    anchor: new Date(day).toISOString().slice(0, 10),
    from: new Date(day - days * DAY_MS).toISOString(),
    to: new Date(day + (days + 1) * DAY_MS - 1).toISOString(),
  };
}
