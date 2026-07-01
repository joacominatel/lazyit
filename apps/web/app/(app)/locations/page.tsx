import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getLocations } from "@/lib/api/endpoints/locations";
import { locationKeys } from "@/lib/api/hooks/use-locations";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { deriveListState, toURLSearchParams } from "@/lib/hooks/list-params-url";
import {
  LOCATION_LIST_OPTIONS,
  deriveLocationParams,
} from "./_components/locations-list-query";
import { LocationsListView } from "./_components/locations-list-view";

/**
 * Locations list — an ADR-0067 server-prefetch pilot route. Prefetches the CURRENT (filtered/paged/
 * searched) location page so the client `LocationsListView` hydrates with data already in cache. The
 * key is derived through the SAME pure code the client uses — `deriveListState` + `deriveLocationParams`
 * (`./_components/locations-list-query`) — so it's byte-identical to `useLocationList(...)`'s key and
 * can't drift into a cache-miss double-fetch (#733). The #600 401 handler stays on the client provider.
 */
export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const session = await auth();
  const queryClient = getServerQueryClient();

  const state = deriveListState(toURLSearchParams(sp), LOCATION_LIST_OPTIONS);
  // ponytail: the archived (`deleted=only`) view is ADMIN-gated on the client; reproducing that key
  // server-side needs the session role. Low-frequency ADMIN slice → skip the prefetch for it and let
  // the client fetch (graceful). Every other filtered/paged/searched URL is prefetched, key-matched.
  if (state.filters.archived !== "only") {
    const params = deriveLocationParams(state, { isAdmin: false });
    await queryClient.prefetchQuery({
      queryKey: locationKeys.list(params),
      queryFn: () => getLocations(params, undefined, session?.accessToken),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LocationsListView />
    </HydrationBoundary>
  );
}
