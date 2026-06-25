import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getConsumable } from "@/lib/api/endpoints/consumables";
import { consumableKeys } from "@/lib/api/hooks/use-consumables";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ConsumableDetailView } from "./_components/consumable-detail-view";

/**
 * Consumable detail — ADR-0067 server-prefetch rollout (#662). This thin Server Component resolves
 * the session, prefetches the consumable's detail (`consumableKeys.detail(id)` via
 * `getConsumable(id, token)`) into a per-request `QueryClient`, dehydrates it, and hydrates the
 * client `ConsumableDetailView` so its `useConsumable(id)` finds the entry already cached on first
 * paint. Secondary reads (movements, categories, users) stay client-fetched — only the primary
 * detail read is prefetched, to keep the rollout uniform and minimal. The #600 401 handler stays on
 * the client provider.
 */
export default async function ConsumableDetailPage({
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
      <ConsumableDetailView id={id} />
    </HydrationBoundary>
  );
}
