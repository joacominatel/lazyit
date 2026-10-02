import { MONEY_MAX } from "../schemas/primitives";
import type { MoneyTotal } from "../schemas/purchase-order";

/**
 * Money totals grouped by free-text currency label (ADR-0099 §5, CEO decision D-C) — one pure definition
 * shared by api (a purchase's derived totals) and web (any aggregate it shows). lazyit never converts and
 * never sums across labels: every amount lands in the group of its own label.
 *
 * Labels compare trimmed and case-insensitively, so "usd" and "USD " are one group; a blank or missing
 * label is the "No currency" group (`currency: null`). A group shows the first spelling it met, trimmed.
 * The sum runs in `bigint`, so no intermediate value loses precision; a group whose sum would exceed
 * `MONEY_MAX` reports `amount: null` rather than an inexact number.
 */

/** One amount to add: its currency label and its value in minor units (`null` = unknown price). */
export interface MoneyAmountEntry {
  currency: string | null | undefined;
  amount: number | bigint | null | undefined;
}

/** The grouping key of a label: trimmed and lower-cased; `""` for a blank or missing label. */
export function currencyGroupKey(label: string | null | undefined): string {
  return (label ?? "").trim().toLowerCase();
}

/**
 * Group `entries` by currency label, in first-seen order. An entry with an unknown amount adds nothing
 * and counts in its group's `unpricedLines`.
 */
export function groupMoneyTotals(entries: readonly MoneyAmountEntry[]): MoneyTotal[] {
  const groups = new Map<string, { currency: string | null; sum: bigint; unpriced: number }>();
  for (const entry of entries) {
    const key = currencyGroupKey(entry.currency);
    let group = groups.get(key);
    if (!group) {
      group = { currency: key === "" ? null : (entry.currency ?? "").trim(), sum: BigInt(0), unpriced: 0 };
      groups.set(key, group);
    }
    if (entry.amount == null) {
      group.unpriced += 1;
    } else {
      group.sum += BigInt(entry.amount);
    }
  }
  const max = BigInt(MONEY_MAX);
  return [...groups.values()].map((group) => ({
    currency: group.currency,
    amount: group.sum > max ? null : Number(group.sum),
    unpricedLines: group.unpriced,
  }));
}
