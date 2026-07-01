import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getConsumables } from "@/lib/api/endpoints/consumables";
import { consumableKeys } from "@/lib/api/hooks/use-consumables";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { deriveListState, toURLSearchParams } from "@/lib/hooks/list-params-url";
import {
  CONSUMABLE_LIST_OPTIONS,
  deriveConsumableParams,
} from "./_components/consumables-list-query";
import { ConsumablesListView } from "./_components/consumables-list-view";

/**
 * Consumables list — an ADR-0067 server-prefetch pilot route. Prefetches the CURRENT (filtered/paged/
 * searched) consumable page so the client `ConsumablesListView` hydrates with data already in cache.
 * The key is derived through the SAME pure code the client uses — `deriveListState` +
 * `deriveConsumableParams` (`./_components/consumables-list-query`) — so it's byte-identical to
 * `useConsumables(...)`'s key and can't drift into a cache-miss double-fetch (#733). The #600 401
 * handler stays on the client provider.
 */
export default async function ConsumablesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const session = await auth();
  const queryClient = getServerQueryClient();

  const state = deriveListState(toURLSearchParams(sp), CONSUMABLE_LIST_OPTIONS);
  // ponytail: the archived (`deleted=only`) view is ADMIN-gated on the client; reproducing that key
  // server-side needs the session role. Low-frequency ADMIN slice → skip the prefetch for it and let
  // the client fetch (graceful). Every other filtered/paged/searched URL is prefetched, key-matched.
  if (state.filters.archived !== "only") {
    const params = deriveConsumableParams(state, { isAdmin: false });
    await queryClient.prefetchQuery({
      queryKey: consumableKeys.list(params),
      queryFn: () => getConsumables(params, undefined, session?.accessToken),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ConsumablesListView />
    </HydrationBoundary>
  );
}
