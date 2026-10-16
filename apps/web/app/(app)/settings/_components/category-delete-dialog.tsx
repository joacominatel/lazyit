"use client";

import {
  type AssetCategoryDeleteImpact,
  CreateApplicationCategorySchema,
  CreateAssetCategorySchema,
  CreateConsumableCategorySchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Combobox } from "@/components/combobox";
import {
  DeleteResolutionDialog,
  type ImpactGroupView,
} from "@/components/delete-resolution-dialog";
import {
  useApplicationCategories,
  useApplicationCategoryDeleteImpact,
  useCreateApplicationCategory,
  useDeleteApplicationCategory,
} from "@/lib/api/hooks/use-application-categories";
import {
  useAssetCategories,
  useAssetCategoryDeleteImpact,
  useCreateAssetCategory,
  useDeleteAssetCategory,
} from "@/lib/api/hooks/use-asset-categories";
import {
  useConsumableCategories,
  useConsumableCategoryDeleteImpact,
  useCreateConsumableCategory,
  useDeleteConsumableCategory,
} from "@/lib/api/hooks/use-consumable-categories";
import { useCan } from "@/lib/hooks/use-permissions";

/** The category kinds whose delete takes one resolution for their items (AUD-085, SEC-041). */
type ResolvableCategoryKind = "application" | "consumable" | "asset";

/** Only the models are re-pointed; their assets are listed because an asset's category comes from its model. */
function assetCategoryImpactGroups(impact: AssetCategoryDeleteImpact): ImpactGroupView[] {
  return [
    {
      key: "assetModels",
      total: impact.assetModels.total,
      items:
        impact.assetModels.items?.map((model) => ({
          id: model.id,
          label: `${model.manufacturer} ${model.name}`,
        })) ?? null,
    },
    {
      key: "assets",
      total: impact.assets.total,
      items:
        impact.assets.items?.map((asset) => ({
          id: asset.id,
          label: asset.assetTag ? `${asset.name} (${asset.assetTag})` : asset.name,
        })) ?? null,
    },
  ];
}

export function CategoryDeleteDialog({
  kind,
  category,
  open,
  onOpenChange,
}: {
  kind: ResolvableCategoryKind;
  category: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("shared.deleteResolution");
  const appImpact = useApplicationCategoryDeleteImpact(
    open && kind === "application" ? category.id : undefined,
  );
  const consumableImpact = useConsumableCategoryDeleteImpact(
    open && kind === "consumable" ? category.id : undefined,
  );
  const assetImpact = useAssetCategoryDeleteImpact(
    open && kind === "asset" ? category.id : undefined,
  );
  const appCategories = useApplicationCategories();
  const consumableCategories = useConsumableCategories();
  const assetCategories = useAssetCategories();
  const removes = {
    application: useDeleteApplicationCategory(),
    consumable: useDeleteConsumableCategory(),
    asset: useDeleteAssetCategory(),
  };
  const creates = {
    application: useCreateApplicationCategory(),
    consumable: useCreateConsumableCategory(),
    asset: useCreateAssetCategory(),
  };
  const canCreate = useCan("category:write");
  const impact = { application: appImpact, consumable: consumableImpact, asset: assetImpact }[kind];
  const list = {
    application: appCategories.data,
    consumable: consumableCategories.data,
    asset: assetCategories.data,
  }[kind];

  const groups = useMemo<ImpactGroupView[] | undefined>(() => {
    if (kind === "asset") {
      return assetImpact.data ? assetCategoryImpactGroups(assetImpact.data) : undefined;
    }
    if (kind === "application") {
      const data = appImpact.data;
      return data
        ? [
            {
              key: "applications",
              total: data.applications.total,
              items:
                data.applications.items?.map((app) => ({ id: app.id, label: app.name })) ?? null,
            },
          ]
        : undefined;
    }
    const data = consumableImpact.data;
    return data
      ? [
          {
            key: "consumables",
            total: data.consumables.total,
            items:
              data.consumables.items?.map((item) => ({
                id: item.id,
                label: item.sku ? `${item.name} (${item.sku})` : item.name,
              })) ?? null,
          },
        ]
      : undefined;
  }, [kind, appImpact.data, consumableImpact.data, assetImpact.data]);

  const targets = useMemo(
    () =>
      (list ?? [])
        .filter((candidate) => candidate.id !== category.id)
        .map((candidate) => ({ value: candidate.id, label: candidate.name })),
    [list, category.id],
  );

  return (
    <DeleteResolutionDialog
      open={open}
      onOpenChange={onOpenChange}
      entityKey="category"
      name={category.name}
      groups={groups}
      impactError={impact.error}
      onRetryImpact={() => void impact.refetch()}
      renderTargetPicker={(picker) => (
        <Combobox
          id={picker.id}
          value={picker.value}
          onValueChange={picker.onValueChange}
          disabled={picker.disabled}
          placeholder={picker.placeholder}
          searchPlaceholder={picker.searchPlaceholder}
          emptyText={picker.emptyText}
          items={
            picker.created && !targets.some((item) => item.value === picker.created?.id)
              ? [...targets, { value: picker.created.id, label: picker.created.name }]
              : targets
          }
        />
      )}
      canCreate={canCreate}
      nameMaxLength={
        {
          application: CreateApplicationCategorySchema,
          consumable: CreateConsumableCategorySchema,
          asset: CreateAssetCategorySchema,
        }[kind].shape.name.maxLength ?? undefined
      }
      createHint={t("createHintCategory")}
      impactNote={kind === "asset" ? t("assetsFollowModel") : undefined}
      remove={(resolution) => removes[kind].mutateAsync({ id: category.id, resolution })}
      create={(name) => creates[kind].mutateAsync({ name })}
    />
  );
}
