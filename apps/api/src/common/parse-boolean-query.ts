/**
 * Parse a boolean query-param string with an explicit default — the single source of truth for
 * boolean query truthiness across the API (consolidates the previously duplicated/divergent
 * parseActiveOnly, parseIncludeExpired and the inline `lowStock === 'true'` check).
 *
 * Truthiness rules (consistent regardless of the default):
 *   - absent (`undefined`)           → `defaultValue`
 *   - "false" / "0" / "no" / "off"   → false
 *   - anything else (incl. a bare    → true
 *     `?flag`, which arrives as "")
 *
 * The two boolean filter families differ only in their DEFAULT, never in their parsing:
 *   - `activeOnly` / `includeExpired` default TRUE (`parseBooleanQuery(v, true)`)
 *   - `lowStock`                      defaults FALSE (`parseBooleanQuery(v)`)
 *
 * Before this, `lowStock` used `=== 'true'` (so `?lowStock=1` was false) while activeOnly used
 * `!== 'false'` (so `?activeOnly=anything` was true) — the same string parsed to different booleans
 * depending on the param. Now every boolean param agrees.
 */
const FALSY = new Set(['false', '0', 'no', 'off']);

export function parseBooleanQuery(
  value: string | undefined,
  defaultValue = false,
): boolean {
  if (value === undefined) return defaultValue;
  return !FALSY.has(value.trim().toLowerCase());
}
