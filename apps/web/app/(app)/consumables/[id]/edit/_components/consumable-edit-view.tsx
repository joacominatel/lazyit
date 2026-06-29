"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { useConsumable } from "@/lib/api/hooks/use-consumables";
import { ConsumableForm } from "../../../_components/consumable-form";

export function ConsumableEditView({ id }: { id: string }) {
  const t = useTranslations("consumables");
  const { data: consumable, isLoading, isError, error, refetch } =
    useConsumable(id);

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: t("list.title"), href: "/consumables" },
          {
            label: consumable?.name ?? "",
            href: `/consumables/${consumable?.id ?? ""}`,
          },
          { label: t("form.breadcrumbEdit") },
        ]}
      />
    ),
    [t, consumable?.name, consumable?.id],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl">
        <DetailSkeleton panels={1} />
      </div>
    );
  }

  if (isError || !consumable) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundDescription")}
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
        title={t("form.editTitle")}
      />
      <ConsumableForm consumable={consumable} />
    </div>
  );
}
