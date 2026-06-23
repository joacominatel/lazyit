import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getAsset } from "@/lib/api/endpoints/assets";
import { assetKeys } from "@/lib/api/hooks/use-assets";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { AssetEditView } from "./_components/asset-edit-view";

/**
 * Edit asset — ADR-0067 server-prefetch rollout (#662). This thin Server Component prefetches the
 * asset's detail (`assetKeys.detail(id)` via `getAsset(id, token)`) — the same read the edit form
 * loads — into a per-request `QueryClient`, dehydrates it, and hydrates the client `AssetEditView`
 * so its `useAsset(id)` finds the entry already cached on first paint. The #600 401 handler stays on
 * the client provider.
 */
export default async function EditAssetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: assetKeys.detail(id),
    queryFn: () => getAsset(id, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AssetEditView id={id} />
    </HydrationBoundary>
  );
}
