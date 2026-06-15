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
 * `select` for the "whole-directory" lookup hooks (`useUsers`, `useAssetModels`) that fetch a single
 * `MAX_PAGE_LIMIT` page and expose just `items` to client-side joiners (pickers, owner/grantee
 * lookups). Returning `page.items` keeps those consumers' `data` shape exactly `T[]`, but a single
 * page silently DROPS rows past the cap — so when `items.length < total` we emit a dev `console.warn`
 * naming the resource and the totals, making the cap loud instead of silent (issue #508). The
 * dedicated searchable, server-paged list hook (`useUserList` / `useAssetModelList`) is the answer
 * for directories that can legitimately exceed the cap.
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
