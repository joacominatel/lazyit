/**
 * A supplier's yearly totals on its page (#1500; ADR-0099 §5, CEO decision D-C) — pure. `GET /suppliers/:id`
 * derives them on every read: per calendar year (the order date, else when the purchase was recorded) and per
 * currency label, never converted and never summed across labels. The web only groups the API's flat list by
 * year, keeping its order (newest year first; within a year, labels in the order the API gave them), and
 * decides what each entry prints.
 */

import type { SupplierYearlyTotal } from "@lazyit/shared";
import { formatMoney } from "@/lib/utils/money";

/** One currency label of one year, as the page prints it. */
export interface YearlyTotalEntry {
  key: string;
  /** The formatted amount with its label; `null` when the sum is too large to display (`amount: null`). */
  text: string | null;
  /** The entry is the *No currency* group (no label, or a blank one). */
  noCurrency: boolean;
  /** Lines with units left and no price: the amount is a partial total. */
  unpricedLines: number;
  purchaseCount: number;
}

/** One year: its entries, one per currency label. */
export interface YearlyTotalGroup {
  year: number;
  entries: YearlyTotalEntry[];
}

/**
 * Group the API's list by year, in the API's order. `undefined` (an API older than #1500) reads as no
 * totals; the caller then shows nothing rather than a misleading "no spend".
 */
export function yearlyTotalGroups(
  totals: readonly SupplierYearlyTotal[] | undefined,
  locale: string,
): YearlyTotalGroup[] | null {
  if (totals === undefined) return null;
  const groups: YearlyTotalGroup[] = [];
  const byYear = new Map<number, YearlyTotalGroup>();
  for (const total of totals) {
    let group = byYear.get(total.year);
    if (!group) {
      group = { year: total.year, entries: [] };
      byYear.set(total.year, group);
      groups.push(group);
    }
    const label = total.currency?.trim() ?? "";
    group.entries.push({
      key: `${total.year}:${label.toLowerCase()}`,
      text: total.amount === null ? null : formatMoney(total.amount, locale, label || null),
      noCurrency: label === "",
      unpricedLines: total.unpricedLines,
      purchaseCount: total.purchaseCount,
    });
  }
  return groups;
}
