import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getConsumable } from "@/lib/api/endpoints/consumables";
import { consumableKeys } from "@/lib/api/hooks/use-consumables";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ConsumableCloneView } from "./_components/consumable-clone-view";

/**
 * Clone consumable — ADR-0067 server-prefetch rollout (#662). This thin Server Component prefetches
 * the source consumable's detail (`consumableKeys.detail(id)` via `getConsumable(id, token)`) — the
 * same read the clone form pre-fills from — into a per-request `QueryClient`, dehydrates it, and
 * hydrates the client `ConsumableCloneView` so its `useConsumable(id)` finds the entry already cached
 * on first paint. The #600 401 handler stays on the client provider.
 */
export default async function CloneConsumablePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, session] = await Promise.all([params, auth()]);
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: consumableKeys.detail(id),
    queryFn: () => getConsumable(id, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ConsumableCloneView id={id} />
    </HydrationBoundary>
  );
}
