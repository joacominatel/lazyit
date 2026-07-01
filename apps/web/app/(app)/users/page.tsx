import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getUsers } from "@/lib/api/endpoints/users";
import { userKeys } from "@/lib/api/hooks/use-users";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { deriveListState, toURLSearchParams } from "@/lib/hooks/list-params-url";
import {
  USER_LIST_OPTIONS,
  deriveUserParams,
} from "./_components/users-list-query";
import { UsersListView } from "./_components/users-list-view";

/**
 * Users (team members) list — an ADR-0067 server-prefetch pilot route. Prefetches the CURRENT
 * (filtered/paged/searched) user page so the client `UsersListView` hydrates with data already in
 * cache. The key is derived through the SAME pure code the client uses — `deriveListState` +
 * `deriveUserParams` (`./_components/users-list-query`) — so it's byte-identical to `useUserList(...)`'s
 * key and can't drift into a cache-miss double-fetch (#733). `status` is a client-side post-filter, so
 * it doesn't affect the key. The #600 401 handler stays on the client provider.
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const session = await auth();
  const queryClient = getServerQueryClient();

  const state = deriveListState(toURLSearchParams(sp), USER_LIST_OPTIONS);
  // ponytail: the archived (`deleted=only`) view is ADMIN-gated on the client; reproducing that key
  // server-side needs the session role. Low-frequency ADMIN slice → skip the prefetch for it and let
  // the client fetch (graceful). Every other filtered/paged/searched URL is prefetched, key-matched.
  if (state.filters.archived !== "only") {
    const params = deriveUserParams(state, { isAdmin: false });
    await queryClient.prefetchQuery({
      queryKey: userKeys.list(params),
      queryFn: () => getUsers(params, undefined, session?.accessToken),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <UsersListView />
    </HydrationBoundary>
  );
}
