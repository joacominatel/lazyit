import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getAssets } from "@/lib/api/endpoints/assets";
import { assetKeys } from "@/lib/api/hooks/use-assets";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { deriveListState, toURLSearchParams } from "@/lib/hooks/list-params-url";
import {
  ASSET_LIST_OPTIONS,
  deriveAssetFilters,
} from "./_components/assets-list-query";
import { AssetsListView } from "./_components/assets-list-view";

/**
 * Assets list — the primary inventory view, an ADR-0067 server-prefetch pilot route. This thin
 * Server Component prefetches the CURRENT (filtered/paged/searched) asset page into a per-request
 * `QueryClient`, dehydrates it, and hydrates the client `AssetsListView`.
 *
 * The prefetched query key MUST be byte-identical to the one the child's `useAssets(filters)` builds
 * for the same URL — otherwise the dehydrated entry misses and the client refetches (a silent
 * double-fetch). We guarantee that by deriving the filters through the SAME pure code the client
 * uses: `deriveListState` (URL → view-state) + `deriveAssetFilters` (view-state → `AssetFilters`),
 * shared via `./_components/assets-list-query` (#733). A no-param URL yields the same first-paint key
 * the unfiltered prefetch always produced. The #600 401 handler stays on the client provider.
 */
export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const session = await auth();
  const queryClient = getServerQueryClient();

  const state = deriveListState(toURLSearchParams(sp), ASSET_LIST_OPTIONS);
  // ponytail: the archived (`deleted=only`) view is ADMIN-gated on the client (`isAdmin && archived`);
  // reproducing that exact key server-side would need the session's role. It's a low-frequency ADMIN
  // slice, so we skip the prefetch for it and let the client fetch (graceful) rather than risk a
  // key mismatch. Every other filtered/paged/searched URL is prefetched, key-matched to the client.
  if (state.filters.archived !== "only") {
    const filters = deriveAssetFilters(state, { isAdmin: false });
    await queryClient.prefetchQuery({
      queryKey: assetKeys.list(filters),
      queryFn: () => getAssets(filters, undefined, session?.accessToken),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AssetsListView />
    </HydrationBoundary>
  );
}
