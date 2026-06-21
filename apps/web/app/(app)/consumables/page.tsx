import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import {
  type ConsumableListParams,
  getConsumables,
} from "@/lib/api/endpoints/consumables";
import { consumableKeys } from "@/lib/api/hooks/use-consumables";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ConsumablesListView } from "./_components/consumables-list-view";

/**
 * Consumables list — an ADR-0067 server-prefetch pilot route. Prefetches the first-paint (unfiltered)
 * consumable page so the client `ConsumablesListView` hydrates with data already in cache. The key
 * must match `useConsumables(params)`'s first-paint params exactly (default sort `updatedAt`/`desc`,
 * `lowStock: false`, limit 50, offset 0); a filtered/paged URL misses and the client fetches it. See
 * the assets page for the full rationale; the #600 401 handler stays on the client provider.
 */
const DEFAULT_PARAMS: ConsumableListParams = {
  q: undefined,
  sort: "updatedAt",
  dir: "desc",
  lowStock: false,
  limit: 50,
  offset: 0,
  deleted: undefined,
};

export default async function ConsumablesPage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: consumableKeys.list(DEFAULT_PARAMS),
    queryFn: () =>
      getConsumables(DEFAULT_PARAMS, undefined, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ConsumablesListView />
    </HydrationBoundary>
  );
}
