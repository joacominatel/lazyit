"use client";

import { useParams } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { useConsumable } from "@/lib/api/hooks/use-consumables";
import { ConsumableForm } from "../../_components/consumable-form";

export default function EditConsumablePage() {
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
          title="Consumable not found"
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
              { label: "Consumables", href: "/consumables" },
              {
                label: consumable.name,
                href: `/consumables/${consumable.id}`,
              },
              { label: "Edit" },
            ]}
          />
        }
        title="Edit consumable"
      />
      <ConsumableForm consumable={consumable} />
    </div>
  );
}
