import type {
  PurchaseApplyAction,
  PurchaseCostValue,
  PurchaseLineValues,
} from "../schemas/purchase-receiving";
import { currencyGroupKey } from "./money-totals";

/**
 * The values a purchase line offers to its assets (ADR-0099 §2, "copy on confirm") and the per-field diff
 * against one asset. Pure and wire-shaped (ISO strings, numbers), so the API computes the link preview with
 * it and the web can show the same prefill in the receive dialog. The mapping is documented in
 * docs/02-domain/entities/purchase-order-line.md.
 */

/** The purchase header values the mapping reads. */
export interface PurchaseValuesHeader {
  orderDate: string | null;
  invoiceDate: string | null;
  currency: string | null;
  company: string | null;
}

/** The line values the mapping reads. `unitPrice` is minor units; `null` = unknown. */
export interface PurchaseValuesLine {
  unitPrice: number | null;
  warrantyMonths: number | null;
  assetModelId: string | null;
}

/**
 * `date` plus `months` calendar months, in UTC. A day that does not exist in the target month clamps to its
 * last day (31 Jan + 1 month = 28/29 Feb), so a warranty never ends in the following month.
 */
export function addMonthsUtc(date: string, months: number): string {
  const source = new Date(date);
  const day = source.getUTCDate();
  const target = new Date(source);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}

/**
 * The warranty end of a unit bought on `purchaseDate` with `warrantyMonths` of warranty; `null` when either
 * is unknown.
 */
export function warrantyEndFrom(
  purchaseDate: string | null,
  warrantyMonths: number | null,
): string | null {
  if (purchaseDate === null || warrantyMonths === null) return null;
  return addMonthsUtc(purchaseDate, warrantyMonths);
}

/**
 * What a LINK offers each existing asset:
 *   - purchase date: the invoice date (what the auditor matches), else the order date;
 *   - cost: the line's unit price with the purchase's currency label (`null` when the price is unknown);
 *   - warranty end: that purchase date + the line's warranty months;
 *   - company: the purchase's; model: the line's.
 * Receiving differs only in the purchase date: with no invoice date it is the day of the receipt, never the
 * order date (persona rule, ux-proposal §3.d).
 */
export function purchaseLineValues(
  purchase: PurchaseValuesHeader,
  line: PurchaseValuesLine,
): PurchaseLineValues {
  const purchaseDate = purchase.invoiceDate ?? purchase.orderDate;
  return {
    purchaseDate,
    purchaseDateSource:
      purchase.invoiceDate !== null ? "INVOICE" : purchase.orderDate !== null ? "ORDER" : null,
    purchaseCost:
      line.unitPrice === null ? null : { amount: line.unitPrice, currency: purchase.currency },
    warrantyEnd: warrantyEndFrom(purchaseDate, line.warrantyMonths),
    company: purchase.company,
    modelId: line.assetModelId,
  };
}

/** The diff action of a plain value (a date compares by instant). */
export function applyActionOf(
  current: string | null,
  offered: string | null,
  kind: "date" | "text" = "text",
): PurchaseApplyAction {
  if (offered === null) return "UNAVAILABLE";
  if (current === null) return "FILL";
  const same =
    kind === "date"
      ? new Date(current).getTime() === new Date(offered).getTime()
      : current === offered;
  return same ? "SAME" : "REPLACE";
}

/**
 * The diff action of a cost: it is a FILL when the asset has no amount, SAME only when the amount AND the
 * currency label match (labels compared trimmed and case-insensitively, ADR-0099 §5), else a REPLACE — a
 * different label is a replace even at the same amount, because cost and currency move together.
 */
export function costApplyActionOf(
  current: PurchaseCostValue,
  offered: PurchaseCostValue | null,
): PurchaseApplyAction {
  if (offered === null || offered.amount === null) return "UNAVAILABLE";
  if (current.amount === null) return "FILL";
  return current.amount === offered.amount &&
    currencyGroupKey(current.currency) === currencyGroupKey(offered.currency)
    ? "SAME"
    : "REPLACE";
}
