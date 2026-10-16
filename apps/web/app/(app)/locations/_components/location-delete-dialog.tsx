"use client";

import {
  CreateLocationSchema,
  type Location,
  type LocationDeleteImpact,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
  DeleteResolutionDialog,
  type ImpactGroupView,
} from "@/components/delete-resolution-dialog";
import { LocationCombobox } from "@/components/location-combobox";
import { locationSubtreeIds } from "@/lib/api/delete-resolution";
import {
  useCreateLocation,
  useDeleteLocation,
  useLocationDeleteImpact,
} from "@/lib/api/hooks/use-location-mutations";
import { useLocations } from "@/lib/api/hooks/use-locations";
import { useCan } from "@/lib/hooks/use-permissions";

export function locationImpactGroups(impact: LocationDeleteImpact): ImpactGroupView[] {
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
      key: "childLocations",
      total: impact.childLocations.total,
      items:
        impact.childLocations.items?.map((child) => ({ id: child.id, label: child.name })) ??
        null,
    },
    {
      key: "purchaseOrders",
      total: impact.purchaseOrders.total,
      items:
        impact.purchaseOrders.items?.map((po) => ({ id: po.id, label: po.reference })) ?? null,
    },
  ];
}

/** Deletes a location, asking for one resolution when assets, child locations or open purchases still point at it (AUD-024). */
export function LocationDeleteDialog({
  location,
  open,
  onOpenChange,
  onDeleted,
}: {
  location: Pick<Location, "id" | "name" | "type" | "parentId">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const t = useTranslations("shared.deleteResolution");
  const impact = useLocationDeleteImpact(open ? location.id : undefined);
  const { data: locations } = useLocations();
  const remove = useDeleteLocation();
  const create = useCreateLocation();
  const canCreate = useCan("location:write");

  const groups = useMemo(
    () => (impact.data ? locationImpactGroups(impact.data) : undefined),
    [impact.data],
  );
  // The subtree known from the cached directory plus the direct children the impact read listed.
  const excludeIds = useMemo(() => {
    const excluded = locationSubtreeIds(locations ?? [], location.id);
    for (const child of impact.data?.childLocations.items ?? []) excluded.add(child.id);
    return excluded;
  }, [locations, location.id, impact.data]);

  return (
    <DeleteResolutionDialog
      open={open}
      onOpenChange={onOpenChange}
      entityKey="location"
      name={location.name}
      groups={groups}
      impactError={impact.error}
      onRetryImpact={() => void impact.refetch()}
      renderTargetPicker={(picker) => (
        <LocationCombobox
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
      canCreate={canCreate}
      nameMaxLength={CreateLocationSchema.shape.name.maxLength ?? undefined}
      createHint={t("createHintLocation", { name: location.name })}
      remove={(resolution) => remove.mutateAsync({ id: location.id, resolution })}
      create={(name) =>
        create.mutateAsync({
          name,
          type: location.type,
          ...(location.parentId ? { parentId: location.parentId } : {}),
        })
      }
      onDeleted={onDeleted}
    />
  );
}
