import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { type UserListParams, getUsers } from "@/lib/api/endpoints/users";
import { userKeys } from "@/lib/api/hooks/use-users";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { UsersListView } from "./_components/users-list-view";

/**
 * Users (team members) list — an ADR-0067 server-prefetch pilot route. Prefetches the first-paint
 * (unfiltered) user page so the client `UsersListView` hydrates with data already in cache. The key
 * must match `useUserList(params)`'s first-paint params exactly (default sort `createdAt`/`desc`,
 * limit 50, offset 0, no archived/directory slice); a filtered/paged URL misses and the client
 * fetches it. See the assets page for the full rationale; the #600 401 handler stays on the client.
 */
const DEFAULT_PARAMS: UserListParams = {
  q: undefined,
  sort: "createdAt",
  dir: "desc",
  limit: 50,
  offset: 0,
  deleted: undefined,
  directoryOnly: undefined,
};

export default async function UsersPage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: userKeys.list(DEFAULT_PARAMS),
    queryFn: () => getUsers(DEFAULT_PARAMS, undefined, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <UsersListView />
    </HydrationBoundary>
  );
}
