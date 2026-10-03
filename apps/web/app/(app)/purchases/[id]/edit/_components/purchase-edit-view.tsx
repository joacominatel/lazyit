"use client";

import { useTranslations } from "next-intl";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { usePurchaseOrder } from "@/lib/api/hooks/use-purchase-orders";
import { PurchaseForm } from "../../../_components/purchase-form";
import { usePurchaseTitle } from "../../../_components/purchase-display";

/** Edit a purchase's header. Its lines are edited on the detail page. */
export function PurchaseEditView({ id }: { id: string }) {
  const t = useTranslations("purchases");
  const titleOf = usePurchaseTitle();
  const { data: purchase, isLoading, isError, error, refetch } = usePurchaseOrder(id);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl">
        <DetailSkeleton panels={2} />
      </div>
    );
  }
  if (isError || !purchase) {
    return (
      <div className="mx-auto max-w-5xl">
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
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t("form.editTitle", { name: titleOf(purchase) })} subtitle={t("form.editSubtitle")} />
      <PurchaseForm purchase={purchase} />
    </div>
  );
}
