import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import {
  type ApplicationListParams,
  getApplications,
} from "@/lib/api/endpoints/applications";
import { applicationKeys } from "@/lib/api/hooks/use-applications";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ApplicationsListView } from "./_components/applications-list-view";

/**
 * Applications (Access) list — an ADR-0067 server-prefetch pilot route. Prefetches the first-paint
 * (unfiltered) application page so the client `ApplicationsListView` hydrates with data already in
 * cache. The key must match `useApplicationList(params)`'s first-paint params exactly (default sort
 * `name`/`asc`, limit 50, offset 0); a filtered/paged URL misses and the client fetches it. See the
 * assets page for the full rationale; the #600 401 handler stays on the client provider.
 */
const DEFAULT_PARAMS: ApplicationListParams = {
  q: undefined,
  sort: "name",
  dir: "asc",
  limit: 50,
  offset: 0,
};

export default async function ApplicationsPage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: applicationKeys.list(DEFAULT_PARAMS),
    queryFn: () =>
      getApplications(DEFAULT_PARAMS, undefined, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ApplicationsListView />
    </HydrationBoundary>
  );
}
