import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getApplication } from "@/lib/api/endpoints/applications";
import { applicationKeys } from "@/lib/api/hooks/use-applications";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ApplicationDetailView } from "./_components/application-detail-view";

/**
 * Application detail — ADR-0067 server-prefetch rollout (#662). This thin Server Component resolves
 * the session, prefetches the application's detail (`applicationKeys.detail(id)` via
 * `getApplication(id, token)`) into a per-request `QueryClient`, dehydrates it, and hydrates the
 * client `ApplicationDetailView` so its `useApplication(id)` finds the entry already cached on first
 * paint. Secondary reads (grants, categories, users) stay client-fetched — only the primary detail
 * read is prefetched, to keep the rollout uniform and minimal. The #600 401 handler stays on the
 * client provider.
 */
export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: applicationKeys.detail(id),
    queryFn: () => getApplication(id, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ApplicationDetailView id={id} />
    </HydrationBoundary>
  );
}
