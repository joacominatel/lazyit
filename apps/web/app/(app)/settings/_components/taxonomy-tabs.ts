/**
 * Settings → Taxonomies (#1540): a grouped list on the left, the selected taxonomy on the right. The
 * pane key is also the `?tab=` value, kept identical to the old tab values so every existing link (the
 * AI assistant links `?tab=statuses`) still opens the same thing. Labels are translated at render via
 * `settings.taxonomies.panes.<key>` and `settings.taxonomies.groups.<group>`.
 */
export const TAXONOMY_PANES = [
  "asset",
  "models",
  "statuses",
  "application",
  "consumable",
] as const;

export type TaxonomyPane = (typeof TAXONOMY_PANES)[number];

/**
 * What a `?tab=` value selects: a taxonomy pane, or `kb` — the old "Article categories" tab, whose
 * categories are the Knowledge Base folders now managed in the KB itself. `kb` renders a pointer there.
 */
export type TaxonomySelection = TaxonomyPane | "kb";

/** The left-hand list: module groups and the panes under each. The Knowledge group is a link to /kb. */
export const TAXONOMY_GROUPS: readonly {
  key: "assets" | "applications" | "consumables";
  panes: readonly TaxonomyPane[];
}[] = [
  { key: "assets", panes: ["asset", "models", "statuses"] },
  { key: "applications", panes: ["application"] },
  { key: "consumables", panes: ["consumable"] },
];

/** Old and alias `?tab=` values that do not name a pane directly. */
const TAB_ALIASES: Record<string, TaxonomySelection> = {
  article: "kb",
  kb: "kb",
};

/** The `?tab=` value → a selection; absent or unknown falls back to asset categories (the old default). */
export function parseTaxonomyTab(value: string | null | undefined): TaxonomySelection {
  if (value == null) return TAXONOMY_PANES[0];
  if ((TAXONOMY_PANES as readonly string[]).includes(value)) return value as TaxonomyPane;
  return TAB_ALIASES[value] ?? TAXONOMY_PANES[0];
}
