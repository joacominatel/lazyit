import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getAsset } from "@/lib/api/endpoints/assets";
import { assetKeys } from "@/lib/api/hooks/use-assets";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { AssetDetailView } from "./_components/asset-detail-view";

/**
 * Asset detail — ADR-0067 server-prefetch rollout (#662). This thin Server Component resolves the
 * session, prefetches the asset's expanded detail (`assetKeys.detail(id)` via `getAsset(id, token)`)
 * into a per-request `QueryClient`, dehydrates it, and hydrates the client `AssetDetailView` so its
 * `useAsset(id)` finds the entry already cached on first paint. Secondary reads (assignments,
 * history, related articles) stay client-fetched — only the primary detail read is prefetched, to
 * keep the rollout uniform and minimal. The #600 401 handler stays on the client provider.
 */
export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, session] = await Promise.all([params, auth()]);
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: assetKeys.detail(id),
    queryFn: () => getAsset(id, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AssetDetailView id={id} />
    </HydrationBoundary>
  );
}
