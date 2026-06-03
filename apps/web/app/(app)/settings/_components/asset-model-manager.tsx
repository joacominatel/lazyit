"use client";

import { CubeIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { AssetModel } from "@lazyit/shared";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  EmptyState,
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
import { useCan } from "@/lib/hooks/use-permissions";
import { formatDate } from "@/lib/utils/format";
import { AssetModelFormDialog } from "./asset-model-form-dialog";

const COLUMNS: ResourceColumn[] = [
  { key: "name", header: "Name", skeleton: <Skeleton className="h-4 w-40" /> },
  {
    key: "manufacturer",
    header: "Manufacturer",
    skeleton: <Skeleton className="h-4 w-24" />,
  },
  { key: "sku", header: "SKU", skeleton: <Skeleton className="h-4 w-20" /> },
  {
    key: "category",
    header: "Category",
    skeleton: <Skeleton className="h-4 w-24" />,
  },
  {
    key: "updated",
    header: "Updated",
    skeleton: <Skeleton className="h-4 w-20" />,
  },
  {
    key: "actions",
    header: "Actions",
    srOnlyHeader: true,
    headClassName: "w-12 text-right",
    skeleton: <Skeleton className="ml-auto size-7" />,
  },
];

/**
 * CRUD table for Asset models in the Taxonomies tabs. Reuses the shared `ResourceTable` /
 * `RowActions` / `DeleteConfirmDialog`; create/edit goes through {@link AssetModelFormDialog}. The
 * asset-categories list is loaded to resolve each model's `categoryId` to a readable name.
 */
export function AssetModelManager() {
  const { data, isLoading, isError, error, refetch } = useAssetModels();
  const { data: categories } = useAssetCategories();
  const remove = useDeleteAssetModel();
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
            New model
          </Button>
        </div>
      ) : null}

      {isLoading ? (
        <ResourceTable columns={COLUMNS} isLoading />
      ) : isError ? (
        <ErrorState
          title="Could not load asset models"
          onRetry={() => refetch()}
          error={error}
        />
      ) : !hasData ? (
        <EmptyState
          icon={CubeIcon}
          title="No asset models yet"
          description="Create a make/model so assets can reference it."
          action={
            canWrite ? (
              <Button onClick={openCreate}>
                <PlusIcon />
                Create the first model
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ResourceTable columns={COLUMNS}>
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
                {formatDate(model.updatedAt)}
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
          entityLabel="asset model"
          name={deleting.name}
          onConfirm={() => remove.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
