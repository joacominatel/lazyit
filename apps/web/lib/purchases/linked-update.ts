/**
 * Re-applying a line's price to the assets already linked to it (#1502; ADR-0099 §2, UX proposal §3.a) —
 * pure. After a line's unit price is edited, the purchase page offers *Update cost on linked assets?*: each
 * linked asset with its current → new cost, pre-checked by the API's "follow unless overridden" rule
 * (`preChecked`), an asset whose cost was changed by hand marked *overridden*. Nothing changes without the
 * click. The apply route takes at most {@link PURCHASE_LINK_MAX_ASSETS} ids per call, so a large line is sent
 * in chunks.
 */

import {
  type ApplyToLinkedAssetsResult,
  PURCHASE_LINK_MAX_ASSETS,
  type PurchaseApplyAction,
  type PurchaseCostValue,
  type PurchaseLinkedPreviewAsset,
  type PurchaseOrderLine,
} from "@lazyit/shared";

/**
 * Whether a line edit calls for the follow-up, and the price it replaced: an `ASSET` line with assets linked
 * whose unit price changed to a price (a price cleared offers nothing to apply — a field is never cleared).
 * `previous` is the line as it read BEFORE the save.
 */
export function linkedPriceFollowUp(
  previous: Pick<PurchaseOrderLine, "kind" | "unitPrice" | "receivedQuantity">,
  updated: Pick<PurchaseOrderLine, "kind" | "unitPrice" | "receivedQuantity">,
): { previousUnitPrice: number | null } | null {
  if (updated.kind !== "ASSET") return null;
  if (Math.max(previous.receivedQuantity, updated.receivedQuantity) <= 0) return null;
  if (updated.unitPrice === null || updated.unitPrice === previous.unitPrice) return null;
  return { previousUnitPrice: previous.unitPrice };
}

/** One linked asset as the follow-up dialog lists it. */
export interface LinkedCostRow {
  assetId: string;
  name: string;
  assetTag: string | null;
  current: PurchaseCostValue;
  /** The cost the purchase offers now; `null` when it offers none. */
  next: PurchaseCostValue | null;
  action: PurchaseApplyAction;
  /** Its cost was changed by hand: a REPLACE of a cost that is not the previous purchase value. */
  overridden: boolean;
  /** Ticking it would change something (a fill or a replace). */
  selectable: boolean;
}

export function linkedCostRows(assets: readonly PurchaseLinkedPreviewAsset[]): LinkedCostRow[] {
  return assets.map((asset) => {
    const cost = asset.fields.purchaseCost;
    const selectable = cost.action === "FILL" || cost.action === "REPLACE";
    return {
      assetId: asset.assetId,
      name: asset.name,
      assetTag: asset.assetTag,
      current: cost.current,
      next: cost.purchase,
      action: cost.action,
      overridden: cost.action === "REPLACE" && asset.holdsPreviousCost === false,
      selectable,
    };
  });
}

/** The ids ticked when the dialog opens: exactly what the API pre-checks for the cost, and only if it can change. */
export function initialLinkedSelection(assets: readonly PurchaseLinkedPreviewAsset[]): Set<string> {
  const rows = new Map(linkedCostRows(assets).map((row) => [row.assetId, row]));
  return new Set(
    assets
      .filter((asset) => asset.preChecked.includes("purchaseCost") && rows.get(asset.assetId)?.selectable)
      .map((asset) => asset.assetId),
  );
}

/** Split ids into calls of at most `size`. */
export function chunkIds(ids: readonly string[], size: number = PURCHASE_LINK_MAX_ASSETS): string[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/** What a chunked apply did, across every call that went through. */
export interface LinkedApplyOutcome {
  updated: number;
  unchanged: number;
  failed: ApplyToLinkedAssetsResult["failed"];
  /** Ids that were never sent because an earlier call failed outright. */
  notSent: number;
  /** The error that stopped the calls, if one did. Earlier calls stay applied (each is its own transaction). */
  error: unknown;
}

/**
 * Apply in chunks, one call after the other. A call that fails outright stops the rest — what earlier calls
 * changed stays changed, and the outcome says how many were never sent.
 */
export async function applyInChunks(
  ids: readonly string[],
  call: (chunk: string[]) => Promise<Pick<ApplyToLinkedAssetsResult, "updated" | "unchanged" | "failed">>,
  size: number = PURCHASE_LINK_MAX_ASSETS,
): Promise<LinkedApplyOutcome> {
  const outcome: LinkedApplyOutcome = { updated: 0, unchanged: 0, failed: [], notSent: 0, error: null };
  const chunks = chunkIds(ids, size);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    try {
      const result = await call(chunk);
      outcome.updated += result.updated.length;
      outcome.unchanged += result.unchanged.length;
      outcome.failed.push(...result.failed);
    } catch (error) {
      outcome.error = error;
      outcome.notSent = chunks.slice(i).reduce((sum, rest) => sum + rest.length, 0);
      break;
    }
  }
  return outcome;
}
