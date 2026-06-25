import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getApplication } from "@/lib/api/endpoints/applications";
import { applicationKeys } from "@/lib/api/hooks/use-applications";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ApplicationEditView } from "./_components/application-edit-view";

/**
 * Edit application — ADR-0067 server-prefetch rollout (#662). This thin Server Component prefetches
 * the application's detail (`applicationKeys.detail(id)` via `getApplication(id, token)`) — the same
 * read the edit form loads — into a per-request `QueryClient`, dehydrates it, and hydrates the client
 * `ApplicationEditView` so its `useApplication(id)` finds the entry already cached on first paint.
 * The #600 401 handler stays on the client provider.
 */
export default async function EditApplicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, session] = await Promise.all([params, auth()]);
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: applicationKeys.detail(id),
    queryFn: () => getApplication(id, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ApplicationEditView id={id} />
    </HydrationBoundary>
  );
}
