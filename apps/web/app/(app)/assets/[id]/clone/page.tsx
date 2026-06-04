"use client";

import { useTranslations } from "next-intl";
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
  const t = useTranslations("assets.form");
  const tList = useTranslations("assets.list");
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
          title={t("notFoundTitle")}
          description={t("notFoundDescription")}
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
              { label: tList("title"), href: "/assets" },
              { label: asset.name, href: `/assets/${asset.id}` },
              { label: t("breadcrumbClone") },
            ]}
          />
        }
        title={t("cloneTitle")}
        subtitle={t("cloneSubtitle")}
      />
      <AssetForm cloneSource={asset} />
    </div>
  );
}
