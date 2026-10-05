/**
 * The Settings → Taxonomies tabs: the four category kinds, asset models, and the custom asset statuses
 * (ADR-0101). The visible label is translated at render via `settings.taxonomies.tabs.<key>`; the key is
 * also the `?tab=` value that links straight to a tab.
 */
export const TAXONOMY_TABS = [
  "asset",
  "application",
  "consumable",
  "article",
  "models",
  "statuses",
] as const;

export type TaxonomyTab = (typeof TAXONOMY_TABS)[number];

/** The `?tab=` value → a tab; absent or unknown falls back to the first one (the page's old default). */
export function parseTaxonomyTab(value: string | null | undefined): TaxonomyTab {
  return (TAXONOMY_TABS as readonly string[]).includes(value ?? "")
    ? (value as TaxonomyTab)
    : TAXONOMY_TABS[0];
}
