import type {
  ApplicationCategory,
  ArticleCategory,
  AssetCategory,
  ConsumableCategory,
} from "@lazyit/shared";

/**
 * The four user-managed category kinds. Mirrors `CategoryKind` in lib/api/endpoints/categories.ts
 * (the inline-create flow), kept local to the Settings → Taxonomies area which adds the full
 * edit/delete management on top of the existing per-kind endpoints.
 */
export type CategoryKind = "asset" | "application" | "consumable" | "article";

/**
 * A category row as rendered in the taxonomy table. The four entities share `id/name/description/
 * icon`; only the asset category lacks `order`, so it is optional here. This is a read-only display
 * shape — writes go through each kind's own typed mutation hook.
 */
export type AnyCategory =
  | AssetCategory
  | ApplicationCategory
  | ConsumableCategory
  | ArticleCategory;

/** Whether a given kind supports the optional `order` sort key (everything except `asset`). */
export function kindHasOrder(kind: CategoryKind): boolean {
  return kind !== "asset";
}

/** Human, singular label for a kind — drives dialog titles, toasts and the delete prompt. */
export const CATEGORY_KIND_LABEL: Record<CategoryKind, string> = {
  asset: "asset category",
  application: "application category",
  consumable: "consumable category",
  article: "article category",
};

/** Read the optional `order` off any category (asset categories never carry one). */
export function categoryOrder(category: AnyCategory): number | null {
  return "order" in category ? (category.order ?? null) : null;
}
