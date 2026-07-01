import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getApplications } from "@/lib/api/endpoints/applications";
import { applicationKeys } from "@/lib/api/hooks/use-applications";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { deriveListState, toURLSearchParams } from "@/lib/hooks/list-params-url";
import {
  APPLICATION_LIST_OPTIONS,
  deriveApplicationParams,
} from "./_components/applications-list-query";
import { ApplicationsListView } from "./_components/applications-list-view";

/**
 * Applications (Access) list — an ADR-0067 server-prefetch pilot route. Prefetches the CURRENT
 * (filtered/paged/searched) application page so the client `ApplicationsListView` hydrates with data
 * already in cache. The key is derived through the SAME pure code the client uses — `deriveListState`
 * + `deriveApplicationParams` (`./_components/applications-list-query`) — so it's byte-identical to
 * `useApplicationList(...)`'s key and can't drift into a cache-miss double-fetch (#733). Category/
 * criticality are a client-side post-filter, so every URL is prefetchable. The #600 401 handler stays
 * on the client provider.
 */
export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const session = await auth();
  const queryClient = getServerQueryClient();

  const state = deriveListState(toURLSearchParams(sp), APPLICATION_LIST_OPTIONS);
  const params = deriveApplicationParams(state);
  await queryClient.prefetchQuery({
    queryKey: applicationKeys.list(params),
    queryFn: () => getApplications(params, undefined, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ApplicationsListView />
    </HydrationBoundary>
  );
}
