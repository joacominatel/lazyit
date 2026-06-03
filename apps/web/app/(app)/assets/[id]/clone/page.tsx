"use client";

import { useParams } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { useAsset } from "@/lib/api/hooks/use-assets";
import { AssetForm } from "../../_components/asset-form";

/**
 * Clone an Asset: mirrors `/[id]/edit` but renders the create form pre-filled from the source record
 * (issue #125). It fetches the source by id and hands it to {@link AssetForm} as `cloneSource`, so the
 * form stays in CREATE mode (CreateAssetSchema + create mutation) with the unique `serial`/`assetTag`
 * cleared and a " (copy)" name. Submitting goes through the normal create flow.
 */
export default function CloneAssetPage() {
  const params = useParams<{ id: string }>();
  const { data: asset, isLoading, isError, error, refetch } = useAsset(
    params.id,
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl">
        <DetailSkeleton panels={1} />
      </div>
    );
  }

  if (isError || !asset) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState
          title="Asset not found"
          description="It may have been deleted, or the API is unreachable."
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "Assets", href: "/assets" },
              { label: asset.name, href: `/assets/${asset.id}` },
              { label: "Clone" },
            ]}
          />
        }
        title="Clone asset"
        subtitle="A new asset pre-filled from this one. Serial and asset tag are cleared — give the copy its own."
      />
      <AssetForm cloneSource={asset} />
    </div>
  );
}
