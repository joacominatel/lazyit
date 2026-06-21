import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import {
  type LocationListParams,
  getLocations,
} from "@/lib/api/endpoints/locations";
import { locationKeys } from "@/lib/api/hooks/use-locations";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { LocationsListView } from "./_components/locations-list-view";

/**
 * Locations list — an ADR-0067 server-prefetch pilot route. Prefetches the first-paint (unfiltered)
 * location page so the client `LocationsListView` hydrates with data already in cache. The key must
 * match `useLocationList(params)`'s first-paint params exactly (default sort `updatedAt`/`desc`,
 * limit 50, offset 0); a filtered/paged URL misses and the client fetches it. See the assets page
 * for the full rationale; the #600 401 handler stays on the client provider.
 */
const DEFAULT_PARAMS: LocationListParams = {
  q: undefined,
  sort: "updatedAt",
  dir: "desc",
  limit: 50,
  offset: 0,
  deleted: undefined,
};

export default async function LocationsPage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: locationKeys.list(DEFAULT_PARAMS),
    queryFn: () => getLocations(DEFAULT_PARAMS, undefined, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LocationsListView />
    </HydrationBoundary>
  );
}
