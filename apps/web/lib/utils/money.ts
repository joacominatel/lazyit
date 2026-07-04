/**
 * Money helpers (#954). Amounts are STORED in **minor units** (cents) — an integer column, no float
 * drift — but operators think in **major units**. These pure functions convert between the two and
 * render a minor-unit amount as a plain, locale-aware 2-decimal number.
 *
 * The model carries **no currency** (single-org, out of scope), so `formatMoney` emits a bare
 * number — no currency symbol, no code. Add a currency only if the domain ever grows one.
 */

/** Minor units (cents) → major units: `1050 → 10.5`. */
export function minorToMajor(cents: number): number {
  return cents / 100;
}

/**
 * Major-unit input (what the operator typed) → minor units (cents), rounded to the nearest cent.
 * Returns `null` for empty/blank/unparseable input so callers can omit (create) or clear (patch)
 * the field. Kept pure — negative values pass through (the form guards them with `min="0"` and the
 * server re-validates non-negative).
 */
export function majorToMinor(value: string | number): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Minor units → a plain, locale-aware 2-decimal string (`123450 → "1,234.50"`). No currency. */
export function formatMoney(cents: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
