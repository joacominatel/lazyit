import { apiFetch } from "../client";

/** The four user-managed category kinds, each with its own CRUD endpoint. */
export type CategoryKind = "asset" | "application" | "consumable" | "article";

const PATH: Record<CategoryKind, string> = {
  asset: "/asset-categories",
  application: "/application-categories",
  consumable: "/consumable-categories",
  article: "/article-categories",
};

/** Minimal created-category shape (every category schema carries at least these). */
export interface CreatedCategory {
  id: string;
  name: string;
}

/**
 * Create a category of the given kind with just a `name` — the common field across all four category
 * schemas, which is all the inline "+ New category" flow needs (richer fields stay editable via the
 * API/seed). The server applies each kind's own defaults and validation.
 */
export function createCategory(
  kind: CategoryKind,
  name: string,
): Promise<CreatedCategory> {
  return apiFetch<CreatedCategory>(PATH[kind], {
    method: "POST",
    body: { name },
  });
}
