import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getUser } from "@/lib/api/endpoints/users";
import { userKeys } from "@/lib/api/hooks/use-users";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { UserDetailView } from "./_components/user-detail-view";

/**
 * User detail — ADR-0067 server-prefetch rollout (#662). This thin Server Component resolves the
 * session, prefetches the user's detail (`userKeys.detail(id)` via `getUser(id, token)`) into a
 * per-request `QueryClient`, dehydrates it, and hydrates the client `UserDetailView` so its
 * `useUser(id)` finds the entry already cached on first paint. The per-person panels (assignments,
 * grants, authored articles) and the catalog reads stay client-fetched — only the primary detail
 * read is prefetched, to keep the rollout uniform and minimal. The #600 401 handler stays on the
 * client provider.
 */
export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, session] = await Promise.all([params, auth()]);
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: userKeys.detail(id),
    queryFn: () => getUser(id, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <UserDetailView id={id} />
    </HydrationBoundary>
  );
}
