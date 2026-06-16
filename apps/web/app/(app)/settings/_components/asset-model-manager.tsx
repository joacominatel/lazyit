"use client";

import { CubeIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { AssetModel } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  ErrorState,
  type ResourceColumn,
  ResourceTable,
  RowActions,
} from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { useAssetCategories } from "@/lib/api/hooks/use-asset-categories";
import {
  useAssetModels,
  useDeleteAssetModel,
} from "@/lib/api/hooks/use-asset-models";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { AssetModelFormDialog } from "./asset-model-form-dialog";

/**
 * CRUD table for Asset models in the Taxonomies tabs. Reuses the shared `ResourceTable` /
 * `RowActions` / `DeleteConfirmDialog`; create/edit goes through {@link AssetModelFormDialog}. The
 * asset-categories list is loaded to resolve each model's `categoryId` to a readable name.
 */
export function AssetModelManager() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const { date } = useFormatters();
  const { data, isLoading, isError, error, refetch } = useAssetModels();
  const { data: categories } = useAssetCategories();
  const remove = useDeleteAssetModel();

  const columns: ResourceColumn[] = [
    {
      key: "name",
      header: t("taxonomies.models.columns.name"),
      skeleton: <Skeleton className="h-4 w-40" />,
    },
    {
      key: "manufacturer",
      header: t("taxonomies.models.columns.manufacturer"),
      skeleton: <Skeleton className="h-4 w-24" />,
    },
    {
      key: "sku",
      header: t("taxonomies.models.columns.sku"),
      skeleton: <Skeleton className="h-4 w-20" />,
    },
    {
      key: "category",
      header: t("taxonomies.models.columns.category"),
      skeleton: <Skeleton className="h-4 w-24" />,
    },
    {
      key: "updated",
      header: t("taxonomies.models.columns.updated"),
      skeleton: <Skeleton className="h-4 w-20" />,
    },
    {
      key: "actions",
      header: tc("actions"),
      srOnlyHeader: true,
      headClassName: "w-12 text-right",
      skeleton: <Skeleton className="ml-auto size-7" />,
    },
  ];
  // Asset-model CRUD is gated on assetModel:write / assetModel:delete (a clone is a create →
  // assetModel:write). The surface lives behind the settings:manage AdminGate; these finer gates
  // match the backend per-affordance and fail closed while the permission set loads.
  const canWrite = useCan("assetModel:write");
  const canDelete = useCan("assetModel:delete");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AssetModel | undefined>(undefined);
  const [cloning, setCloning] = useState<AssetModel | undefined>(undefined);
  const [deleting, setDeleting] = useState<AssetModel | undefined>(undefined);

  const categoryName = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories ?? []) map.set(category.id, category.name);
    return map;
  }, [categories]);

  function openCreate() {
    setEditing(undefined);
    setCloning(undefined);
    setFormOpen(true);
  }

  function openEdit(model: AssetModel) {
    setCloning(undefined);
    setEditing(model);
    setFormOpen(true);
  }

  function openClone(model: AssetModel) {
    setEditing(undefined);
    setCloning(model);
    setFormOpen(true);
  }

  const models = data ?? [];
  const hasData = models.length > 0;

  return (
    <div className="space-y-4">
      {canWrite ? (
        <div className="flex items-center justify-end">
          <Button onClick={openCreate} size="sm">
            <PlusIcon />
            {t("taxonomies.models.newButton")}
          </Button>
        </div>
      ) : null}

      {isLoading ? (
        <ResourceTable columns={columns} isLoading />
      ) : isError ? (
        <ErrorState
          title={t("taxonomies.models.loadError")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : !hasData ? (
        <EmptyState
          icon={CubeIcon}
          pillar="inventory"
          title={t("taxonomies.models.emptyTitle")}
          description={t("taxonomies.models.emptyDescription")}
          action={
            canWrite
              ? {
                  label: t("taxonomies.models.emptyAction"),
                  onClick: openCreate,
                }
              : undefined
          }
        />
      ) : (
        <ResourceTable columns={columns}>
          {models.map((model) => (
            <TableRow key={model.id}>
              <TableCell className="font-medium">{model.name}</TableCell>
              <TableCell className="text-muted-foreground">
                {model.manufacturer}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {model.sku ?? "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {model.categoryId
                  ? (categoryName.get(model.categoryId) ?? "—")
                  : "—"}
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {date(model.updatedAt)}
              </TableCell>
              <TableCell className="text-right">
                {canWrite || canDelete ? (
                  <RowActions
                    onEdit={canWrite ? () => openEdit(model) : undefined}
                    onClone={canWrite ? () => openClone(model) : undefined}
                    onDelete={canDelete ? () => setDeleting(model) : undefined}
                  />
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </ResourceTable>
      )}

      <AssetModelFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        model={editing}
        cloneSource={cloning}
      />
      {deleting ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined);
          }}
          entityKey="model"
          name={deleting.name}
          onConfirm={() => remove.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
