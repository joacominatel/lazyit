/**
 * Straight-line asset depreciation (#954) — a single pure, framework-agnostic function shared by api
 * (computes `currentBookValue` on the asset detail read) and web (may format/preview the same number).
 *
 * Money is INTEGER minor units (e.g. cents) of the instance's single currency — the same units the
 * `Asset.purchaseCost` / `salvageValue` columns store. Straight-line ONLY: the value falls in equal
 * steps from `purchaseCost` at `purchaseDate` down to `salvageValue` after `usefulLifeMonths`, then
 * stays flat. No MACRS / declining-balance / tax modeling, no multi-currency (deliberately minimal).
 */

/** The stored depreciation inputs (all nullable — money in minor units, life in months). */
export interface AssetDepreciationInput {
  /** Acquisition cost in minor units; `null`/absent = unknown. */
  purchaseCost: number | null | undefined;
  /** Straight-line depreciation period in months; `null`/absent or `<= 0` = don't depreciate. */
  usefulLifeMonths: number | null | undefined;
  /** Residual value at end of life, minor units; `null`/absent = 0. */
  salvageValue: number | null | undefined;
  /** When depreciation starts. A `Date`, an ISO string, or `null`/absent (= can't depreciate). */
  purchaseDate: Date | string | null | undefined;
}

/** Whole calendar months elapsed from `start` to `end` (UTC, deterministic across TZs), clamped >= 0. */
function wholeMonthsElapsed(start: Date, end: Date): number {
  let months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());
  // The final partial month hasn't completed until the day-of-month is reached.
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(months, 0);
}

/**
 * The current book value in minor units, or `null` when it can't be known.
 *
 * - `purchaseCost == null` → `null` (unknown).
 * - No `usefulLifeMonths` (or `<= 0`) or no parseable `purchaseDate` → `purchaseCost` (can't
 *   depreciate; current value = cost).
 * - Otherwise straight-line: `salvage = salvageValue ?? 0`; over `min(elapsedMonths / usefulLifeMonths,
 *   1)` of the `(purchaseCost - salvage)` depreciable base, rounded, then clamped to `[salvage,
 *   purchaseCost]` so it never dips below salvage nor rises above cost (guards bad salvage/cost data).
 */
export function computeAssetBookValue(
  input: AssetDepreciationInput,
  asOf: Date,
): number | null {
  const { purchaseCost, usefulLifeMonths, salvageValue, purchaseDate } = input;
  if (purchaseCost == null) return null;
  if (
    usefulLifeMonths == null ||
    usefulLifeMonths <= 0 ||
    purchaseDate == null
  ) {
    return purchaseCost;
  }
  const start =
    purchaseDate instanceof Date ? purchaseDate : new Date(purchaseDate);
  if (Number.isNaN(start.getTime())) return purchaseCost; // unparseable date → can't depreciate

  const salvage = salvageValue ?? 0;
  const depreciable = purchaseCost - salvage;
  const fraction = Math.min(
    wholeMonthsElapsed(start, asOf) / usefulLifeMonths,
    1,
  );
  const bookValue = Math.round(purchaseCost - depreciable * fraction);
  // Floor at salvage, cap at cost — order chosen so degenerate data (salvage > cost) collapses to cost.
  return Math.min(Math.max(bookValue, salvage), purchaseCost);
}
