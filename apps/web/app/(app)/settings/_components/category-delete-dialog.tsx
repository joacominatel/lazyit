"use client";

import {
  CreateApplicationCategorySchema,
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
  useConsumableCategories,
  useConsumableCategoryDeleteImpact,
  useCreateConsumableCategory,
  useDeleteConsumableCategory,
} from "@/lib/api/hooks/use-consumable-categories";
import { useCan } from "@/lib/hooks/use-permissions";

/** The category kinds whose delete takes one resolution for their items (AUD-085). */
type ResolvableCategoryKind = "application" | "consumable";

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
  const appCategories = useApplicationCategories();
  const consumableCategories = useConsumableCategories();
  const removes = {
    application: useDeleteApplicationCategory(),
    consumable: useDeleteConsumableCategory(),
  };
  const creates = {
    application: useCreateApplicationCategory(),
    consumable: useCreateConsumableCategory(),
  };
  const canCreate = useCan("category:write");
  const impact = kind === "application" ? appImpact : consumableImpact;
  const list = kind === "application" ? appCategories.data : consumableCategories.data;

  const groups = useMemo<ImpactGroupView[] | undefined>(() => {
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
  }, [kind, appImpact.data, consumableImpact.data]);

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
        (kind === "application"
          ? CreateApplicationCategorySchema
          : CreateConsumableCategorySchema
        ).shape.name.maxLength ?? undefined
      }
      createHint={t("createHintCategory")}
      remove={(resolution) => removes[kind].mutateAsync({ id: category.id, resolution })}
      create={(name) => creates[kind].mutateAsync({ name })}
    />
  );
}
