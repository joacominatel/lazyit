"use client";

import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { useConsumable } from "@/lib/api/hooks/use-consumables";
import { ConsumableForm } from "../../_components/consumable-form";

/**
 * Clone a Consumable: mirrors `/[id]/edit` but renders the create form pre-filled from the source
 * record (issue #125). It fetches the source by id and hands it to {@link ConsumableForm} as
 * `cloneSource`, so the form stays in CREATE mode (CreateConsumableSchema + create mutation) with the
 * unique `sku` cleared and a " (copy)" name. `currentStock` starts at 0 (ADR-0034) — never cloned.
 */
export default function CloneConsumablePage() {
  const t = useTranslations("consumables");
  const params = useParams<{ id: string }>();
  const { data: consumable, isLoading, isError, error, refetch } =
    useConsumable(params.id);

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
        breadcrumb={
          <Breadcrumb
            items={[
              { label: t("list.title"), href: "/consumables" },
              {
                label: consumable.name,
                href: `/consumables/${consumable.id}`,
              },
              { label: t("form.breadcrumbClone") },
            ]}
          />
        }
        title={t("form.cloneTitle")}
        subtitle={t("form.cloneSubtitle")}
      />
      <ConsumableForm cloneSource={consumable} />
    </div>
  );
}
