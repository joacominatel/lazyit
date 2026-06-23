import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getLocation } from "@/lib/api/endpoints/locations";
import { locationKeys } from "@/lib/api/hooks/use-locations";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { LocationDetailView } from "./_components/location-detail-view";

/**
 * Location detail — ADR-0067 server-prefetch rollout (#662). This thin Server Component resolves the
 * session, prefetches the location's detail (`locationKeys.detail(id)` via `getLocation(id, token)`)
 * into a per-request `QueryClient`, dehydrates it, and hydrates the client `LocationDetailView` so
 * its `useLocation(id)` finds the entry already cached on first paint. The "assets here" read stays
 * client-fetched — only the primary detail read is prefetched, to keep the rollout uniform and
 * minimal. The #600 401 handler stays on the client provider.
 */
export default async function LocationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: locationKeys.detail(id),
    queryFn: () => getLocation(id, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LocationDetailView id={id} />
    </HydrationBoundary>
  );
}
