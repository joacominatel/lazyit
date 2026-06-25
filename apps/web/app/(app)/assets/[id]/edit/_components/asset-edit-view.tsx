"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { useAsset } from "@/lib/api/hooks/use-assets";
import { AssetForm } from "../../../_components/asset-form";

export function AssetEditView({ id }: { id: string }) {
  const t = useTranslations("assets.form");
  const tList = useTranslations("assets.list");
  const { data: asset, isLoading, isError, error, refetch } = useAsset(id);

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: tList("title"), href: "/assets" },
          { label: asset?.name ?? "", href: `/assets/${asset?.id ?? ""}` },
          { label: t("breadcrumbEdit") },
        ]}
      />
    ),
    [t, tList, asset?.name, asset?.id],
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
        breadcrumb={breadcrumb}
        title={t("editTitle")}
      />
      <AssetForm asset={asset} />
    </div>
  );
}
