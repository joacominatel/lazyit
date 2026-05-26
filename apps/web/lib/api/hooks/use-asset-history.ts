import { useInfiniteQuery } from "@tanstack/react-query";
import { getAssetHistory } from "../endpoints/asset-history";

/** Per-page size for the timeline (the API caps at 100). */
const PAGE_SIZE = 50;

/** Query keys for an asset's history (read-only; append-only log, nothing invalidates it). */
export const assetHistoryKeys = {
  all: ["asset-history"] as const,
  list: (assetId: string) => [...assetHistoryKeys.all, assetId] as const,
};

/**
 * Paginated AssetHistory for one asset (ADR-0033), newest first. Cursor on the autoincrement id —
 * each page asks for events `before` the last id seen; a full page implies there may be more.
 * Idle until an id is provided.
 */
export function useAssetHistory(assetId: string | undefined) {
  return useInfiniteQuery({
    queryKey: assetHistoryKeys.list(assetId ?? ""),
    queryFn: ({ pageParam }) =>
      getAssetHistory(assetId as string, {
        limit: PAGE_SIZE,
        before: pageParam,
      }),
    enabled: Boolean(assetId),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === PAGE_SIZE
        ? lastPage[lastPage.length - 1].id
        : undefined,
  });
}
