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
  if (!canReadPurchases) return undefined;
  const out: PurchaseAssetFilter = {};
  if (filter.purchaseOrderLineId) out.purchaseOrderLineId = filter.purchaseOrderLineId;
  if (filter.purchaseOrderId) out.purchaseOrderId = filter.purchaseOrderId;
  if (filter.purchaseLinked !== undefined) out.purchaseLinked = filter.purchaseLinked;
  return Object.keys(out).length > 0 ? out : undefined;
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
}: {
  q: string;
  modelId: string | null;
  notLinked: boolean;
  canReadPurchases: boolean;
}): AssetFilters {
  const purchase = notLinked ? purchaseAssetFilter(canReadPurchases, { purchaseLinked: false }) : undefined;
  return {
    q: q || undefined,
    modelId: modelId ?? undefined,
    ...(purchase ? { purchase } : {}),
    limit: 50,
  };
}
