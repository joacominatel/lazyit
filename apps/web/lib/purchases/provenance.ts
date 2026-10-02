/**
 * The asset page's *Purchase* panel (ADR-0099 §8, CEO decision D-A), pure. Provenance — supplier,
 * reference, dates, invoice numbers, the purchase's documents — follows `purchaseOrder:read`: without it the
 * panel never renders and its read is never made. The asset's own cost and dates stay in *Details* under
 * `asset:read`, as before.
 */

import { costApplyActionOf } from "@lazyit/shared";

/**
 * What the panel shows:
 *   - `hidden`     — no `purchaseOrder:read`, or not linked and the viewer cannot link (nothing to say);
 *   - `provenance` — linked: read `GET /assets/:id/purchase` and show it;
 *   - `link`       — not linked, and the viewer may link it (`purchaseOrder:write` + `asset:write`).
 */
export type PurchasePanelMode = "hidden" | "provenance" | "link";

export function purchasePanelMode({
  canReadPurchases,
  canLink,
  linked,
  archived,
}: {
  canReadPurchases: boolean;
  canLink: boolean;
  /** The asset carries a `purchaseOrderLineId`. */
  linked: boolean;
  /** The asset itself is archived: it can still show where it came from, but is not linked from here. */
  archived: boolean;
}): PurchasePanelMode {
  if (!canReadPurchases) return "hidden";
  if (linked) return "provenance";
  return canLink && !archived ? "link" : "hidden";
}

/**
 * "Differs from purchase" — shown for the cost only (UX proposal §2.3: dates legitimately differ per
 * delivery). True when the asset holds a cost and the line a price, and they differ in amount or currency
 * label (labels compared trimmed and case-insensitively, the same rule as the link diff). An asset with no
 * cost, or a line with no price, does not "differ": there is nothing to compare.
 */
export function costDiffersFromPurchase(
  asset: { purchaseCost?: number | null; purchaseCurrency?: string | null },
  line: { unitPrice: number | null },
  purchaseCurrency: string | null,
): boolean {
  if (line.unitPrice === null || asset.purchaseCost == null) return false;
  return (
    costApplyActionOf(
      { amount: asset.purchaseCost, currency: asset.purchaseCurrency ?? null },
      { amount: line.unitPrice, currency: purchaseCurrency },
    ) === "REPLACE"
  );
}

/**
 * The purchase title's source on the asset's panel (ADR-0099 §6): the purchase's own fields, dated by when
 * the PURCHASE was recorded (`createdAt`, #1476) when it has no order date — the same title it has
 * everywhere else. A read without `createdAt` (an API older than #1476) falls back to the line's.
 */
export function provenanceTitleSource<
  P extends { reference: string | null; supplier: { name: string } | null; orderDate: string | null; createdAt?: string },
>(purchase: P, line: { createdAt: string }): P & { createdAt: string } {
  return { ...purchase, createdAt: purchase.createdAt ?? line.createdAt };
}
