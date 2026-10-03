import { formatMoney } from "@/lib/utils/money";

/**
 * The Assets-table columns an operator can show/hide via the column picker (#695). The `name` identity
 * column (the row's canonical link) and the row `actions` column are always rendered and intentionally
 * absent here. Keys match the `ResourceColumn` keys and the per-key body-cell map in the list view, so
 * the header and body never drift, and the ARRAY ORDER is the canonical left-to-right table order
 * (persistence re-emits selections in this order). Ported from the Users picker and scoped to this page
 * by CTO decision (the shared `ResourceTable` stays untouched).
 */
export const HIDEABLE_COLUMNS = [
  "assetTag",
  "serial",
  "manufacturer",
  "model",
  "category",
  "location",
  "company",
  "status",
  "owners",
  "purchaseDate",
  "warrantyEnd",
  "purchaseCost",
  "updated",
] as const;
export type HideableColumn = (typeof HIDEABLE_COLUMNS)[number];

/**
 * Column-picker grouping — purely presentational structure for the dropdown so the list reads as
 * labelled sections. The flattened union of `keys` MUST equal `HIDEABLE_COLUMNS` (every hideable
 * column appears in exactly one group); it drives only the menu, never visibility.
 */
export const COLUMN_GROUPS: { id: string; keys: readonly HideableColumn[] }[] = [
  {
    id: "details",
    keys: ["assetTag", "serial", "manufacturer", "model", "category", "location", "company"],
  },
  { id: "status", keys: ["status", "owners"] },
  { id: "purchase", keys: ["purchaseDate", "warrantyEnd", "purchaseCost"] },
  { id: "activity", keys: ["updated"] },
];

/**
 * Columns added after the picker shipped (#1511): off until an operator turns them on, so a list
 * nobody configured looks exactly as it did. A list someone configured never lists them either — the
 * stored set is what is shown.
 */
const OPT_IN_COLUMNS: readonly HideableColumn[] = [
  "serial",
  "manufacturer",
  "purchaseDate",
  "warrantyEnd",
  "purchaseCost",
];

/** The columns shown when the operator never opened the picker. */
export const DEFAULT_VISIBLE_COLUMNS: HideableColumn[] = HIDEABLE_COLUMNS.filter(
  (key) => !OPT_IN_COLUMNS.includes(key),
);

function knownColumns(stored: unknown): HideableColumn[] {
  return (Array.isArray(stored) ? stored : DEFAULT_VISIBLE_COLUMNS).filter(
    (key): key is HideableColumn => HIDEABLE_COLUMNS.includes(key),
  );
}

/**
 * The visible hideable columns. Before mount (SSR and first paint) it is always the defaults, so the
 * persisted set never causes a hydration flash; after mount it is the stored set, defended against
 * stale or garbage storage (renamed/removed keys, or a non-array shape from an older build).
 */
export function visibleColumnSet(
  stored: unknown,
  mounted: boolean,
): Set<HideableColumn> {
  return new Set(mounted ? knownColumns(stored) : DEFAULT_VISIBLE_COLUMNS);
}

/** The stored set after showing or hiding `key`, re-emitted in canonical column order. */
export function toggledColumns(
  stored: unknown,
  key: HideableColumn,
  visible: boolean,
): HideableColumn[] {
  const kept = knownColumns(stored);
  if (!visible) return kept.filter((k) => k !== key);
  if (kept.includes(key)) return kept;
  return HIDEABLE_COLUMNS.filter((k) => k === key || kept.includes(k));
}

/**
 * The Cost cell: the amount as entered with its currency label (ADR-0099 §5, ADR-0100), and whether it
 * has no label — "No currency" is its own visible state, never a default currency. `null` when the cost
 * is unknown, or when the row carries none.
 */
export function listCost(
  cost: number | null | undefined,
  currency: string | null | undefined,
  locale: string,
): { amount: string; noCurrency: boolean } | null {
  if (cost == null) return null;
  return {
    amount: formatMoney(cost, locale, currency),
    noCurrency: !currency?.trim(),
  };
}
