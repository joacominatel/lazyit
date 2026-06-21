import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { type AssetFilters, getAssets } from "@/lib/api/endpoints/assets";
import { assetKeys } from "@/lib/api/hooks/use-assets";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { AssetsListView } from "./_components/assets-list-view";

/**
 * Assets list — the primary inventory view, an ADR-0067 server-prefetch pilot route. This thin
 * Server Component prefetches the FIRST-PAINT (unfiltered) asset page into a per-request
 * `QueryClient`, dehydrates it, and hydrates the client `AssetsListView`.
 *
 * The prefetched query key MUST be byte-identical to the one the child's `useAssets(filters)` builds
 * on a fresh load with no URL params — otherwise the dehydrated entry won't hit and the client would
 * refetch (double-fetch). `AssetsListView` derives its filters from `useListParams` (default sort
 * `updatedAt`/`desc`, limit 50, offset 0) and maps every "ALL"/disabled filter to `undefined`, so a
 * no-param load yields exactly {@link DEFAULT_FILTERS} below. Any URL with filters/paging is NOT
 * prefetched here — it simply misses the cache and the client fetches it (the correct degraded path
 * for a lower-frequency case). The #600 401 handler stays on the client provider, untouched.
 */
const DEFAULT_FILTERS: AssetFilters = {
  q: undefined,
  status: undefined,
  categoryId: undefined,
  locationId: undefined,
  sort: "updatedAt",
  dir: "desc",
  limit: 50,
  offset: 0,
  deleted: undefined,
};

export default async function AssetsPage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: assetKeys.list(DEFAULT_FILTERS),
    queryFn: () => getAssets(DEFAULT_FILTERS, undefined, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AssetsListView />
    </HydrationBoundary>
  );
}
