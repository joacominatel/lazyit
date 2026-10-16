"use client";

import {
  type AssetModel,
  type AssetModelDeleteImpact,
  CreateAssetModelSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { AssetModelCombobox } from "@/components/asset-model-combobox";
import {
  DeleteResolutionDialog,
  type ImpactGroupView,
} from "@/components/delete-resolution-dialog";
import { replacementModelInput } from "@/lib/api/delete-resolution";
import { useAssetCategories } from "@/lib/api/hooks/use-asset-categories";
import {
  useAssetModelDeleteImpact,
  useCreateAssetModel,
  useDeleteAssetModel,
} from "@/lib/api/hooks/use-asset-models";
import { useCan } from "@/lib/hooks/use-permissions";

export function assetModelImpactGroups(impact: AssetModelDeleteImpact): ImpactGroupView[] {
  return [
    {
      key: "assets",
      total: impact.assets.total,
      items:
        impact.assets.items?.map((asset) => ({
          id: asset.id,
          label: asset.assetTag ? `${asset.name} (${asset.assetTag})` : asset.name,
        })) ?? null,
    },
    {
      key: "purchaseOrderLines",
      total: impact.purchaseOrderLines.total,
      items:
        impact.purchaseOrderLines.items?.map((line) => ({
          id: line.id,
          label: line.reference ?? line.description,
          href: `/purchases/${line.purchaseOrderId}`,
        })) ?? null,
    },
  ];
}

/** Deletes an asset model, asking for one resolution when assets or open purchase lines still use it (SEC-041). */
export function AssetModelDeleteDialog({
  model,
  open,
  onOpenChange,
}: {
  model: Pick<AssetModel, "id" | "name" | "manufacturer" | "categoryId">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("shared.deleteResolution");
  const impact = useAssetModelDeleteImpact(open ? model.id : undefined);
  const categories = useAssetCategories();
  const remove = useDeleteAssetModel();
  const create = useCreateAssetModel();
  const canWrite = useCan("assetModel:write");

  const groups = useMemo(
    () => (impact.data ? assetModelImpactGroups(impact.data) : undefined),
    [impact.data],
  );
  const excludeIds = useMemo(() => new Set([model.id]), [model.id]);
  // The list holds live categories only, so a category missing from it is archived.
  const liveCategoryIds = useMemo(
    () => new Set((categories.data ?? []).map((category) => category.id)),
    [categories.data],
  );
  const categoryResolved = !model.categoryId || categories.isSuccess;
  const keepsCategory = model.categoryId != null && liveCategoryIds.has(model.categoryId);

  return (
    <DeleteResolutionDialog
      open={open}
      onOpenChange={onOpenChange}
      entityKey="model"
      name={model.name}
      groups={groups}
      impactError={impact.error}
      onRetryImpact={() => void impact.refetch()}
      renderTargetPicker={(picker) => (
        <AssetModelCombobox
          id={picker.id}
          value={picker.value}
          onValueChange={picker.onValueChange}
          disabled={picker.disabled}
          placeholder={picker.placeholder}
          searchPlaceholder={picker.searchPlaceholder}
          emptyText={picker.emptyText}
          excludeIds={excludeIds}
        />
      )}
      canCreate={canWrite && categoryResolved}
      nameMaxLength={CreateAssetModelSchema.shape.name.maxLength ?? undefined}
      createHint={
        keepsCategory
          ? t("createHintModel", { name: model.name, manufacturer: model.manufacturer })
          : model.categoryId
            ? t("createHintModelArchivedCategory", {
                name: model.name,
                manufacturer: model.manufacturer,
              })
            : t("createHintModelNoCategory", { name: model.name, manufacturer: model.manufacturer })
      }
      remove={(resolution) => remove.mutateAsync({ id: model.id, resolution })}
      create={(name) => create.mutateAsync(replacementModelInput(model, name, liveCategoryIds))}
    />
  );
}
