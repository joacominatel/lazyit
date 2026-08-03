/**
 * Builds the standard TanStack query-key factory for a resource. Centralizing
 * the shape means the read hooks and the mutations that invalidate them can't
 * drift:
 *
 * - `all`        → `[name]`               — root/prefix for the whole resource
 * - `lists()`    → `[name, "list"]`       — the list query
 * - `detail(id)` → `[name, "detail", id]` — a single record
 *
 * Mutations invalidate `all`; being the common prefix, it refetches both lists
 * and details. The `const` type param keeps `name` a string literal, so keys
 * stay precisely typed (e.g. `readonly ["locations", "list"]`). See ADR-0020.
 */
export function createQueryKeys<const TName extends string>(name: TName) {
  const all = [name] as const;
  return {
    all,
    lists: () => [...all, "list"] as const,
    detail: (id: string) => [...all, "detail", id] as const,
  };
}

/** The page-envelope shape (subset of `@lazyit/shared`'s `Page<T>`) a directory `select` reads. */
interface DirectoryPage<T> {
  items: T[];
  total: number;
}

/**
 * `select` for the "whole-directory" lookup hook (`useAssetModels`) that fetches a single
 * `MAX_PAGE_LIMIT` page and exposes just `items` to client-side joiners (pickers, model lookups).
 * Returning `page.items` keeps those consumers' `data` shape exactly `T[]`, but a single page silently
 * DROPS rows past the cap — so when `items.length < total` we emit a dev `console.warn` naming the
 * resource and the totals, making the cap loud instead of silent (issue #508). The dedicated
 * searchable, server-paged list hook (`useAssetModelList`) is the answer for directories that can
 * legitimately exceed the cap. (The users directory dropped this pattern in #961 for the batch
 * {@link useUserNames} id→name resolver — see `lib/api/hooks/use-users.ts`.)
 */
export function selectDirectoryItems<T>(resource: string) {
  return (page: DirectoryPage<T>): T[] => {
    if (
      process.env.NODE_ENV !== "production" &&
      page.items.length < page.total
    ) {
      console.warn(
        `[${resource}] directory truncated: showing ${page.items.length} of ${page.total}. ` +
          `Rows past the page cap are dropped from client-side lookups — use the searchable ` +
          `server-paged list hook for this resource.`,
      );
    }
    return page.items;
  };
}

/**
 * Query keys for the org-wide asset-tag scheme (ADR-0063, #363). A SINGLETON config row (no list /
 * detail), so it doesn't use the `createQueryKeys` factory — one `single()` key is the whole resource.
 * Shaped like `configKeys`: `all` is the invalidation prefix the PUT mutation refetches.
 */
export const assetTagSchemeKeys = {
  all: ["asset-tag-scheme"] as const,
  single: () => [...["asset-tag-scheme"], "single"] as const,
  /**
   * The seed suggestion for a pattern (ADR-0068 §2). Keyed by the (prefix, suffix, width) so the
   * editor refetches only when the operator changes the template, not on every keystroke elsewhere.
   */
  seedSuggestion: (params: {
    prefix?: string;
    suffix?: string;
    width?: number;
  }) => [...["asset-tag-scheme"], "seed-suggestion", params] as const,
  /**
   * The next tag the scheme would allocate for a pattern (#1180). Keyed by the whole pattern
   * INCLUDING the counter floor `from`, because changing the floor changes the answer — sharing a key
   * across floors would serve one floor's preview for another and re-introduce the lie this fixes.
   * Sits under the `all` prefix so a save (or a backfill apply) invalidates it with everything else.
   */
  nextPreview: (params: {
    prefix?: string;
    suffix?: string;
    width?: number;
    from?: number;
  }) => [...["asset-tag-scheme"], "next-preview", params] as const,
  /**
   * A backfill preview page (ADR-0068 §4). Keyed by the scope + page window so paging within the
   * wizard caches per page; switching mode/model is a distinct key (a fresh preview).
   */
  backfillPreview: (params: {
    mode: string;
    modelId?: string;
    page?: number;
    pageSize?: number;
  }) => [...["asset-tag-scheme"], "backfill-preview", params] as const,
};

