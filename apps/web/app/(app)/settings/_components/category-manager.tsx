"use client";

import { PlusIcon, TagIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
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
import { useApplicationCategories, useDeleteApplicationCategory } from "@/lib/api/hooks/use-application-categories";
import { useArticleCategories, useDeleteArticleCategory } from "@/lib/api/hooks/use-article-categories";
import { useAssetCategories, useDeleteAssetCategory } from "@/lib/api/hooks/use-asset-categories";
import { useConsumableCategories, useDeleteConsumableCategory } from "@/lib/api/hooks/use-consumable-categories";
import { formatDate } from "@/lib/utils/format";
import { CategoryFormDialog } from "./category-form-dialog";
import {
  type AnyCategory,
  CATEGORY_KIND_LABEL,
  type CategoryKind,
  categoryOrder,
  kindHasOrder,
} from "./taxonomy-types";

const BASE_COLUMNS: ResourceColumn[] = [
  { key: "name", header: "Name", skeleton: <Skeleton className="h-4 w-40" /> },
  {
    key: "description",
    header: "Description",
    skeleton: <Skeleton className="h-4 w-56" />,
  },
];

const ORDER_COLUMN: ResourceColumn = {
  key: "order",
  header: "Order",
  headClassName: "w-20",
  skeleton: <Skeleton className="h-4 w-8" />,
};

const TAIL_COLUMNS: ResourceColumn[] = [
  { key: "updated", header: "Updated", skeleton: <Skeleton className="h-4 w-20" /> },
  {
    key: "actions",
    header: "Actions",
    srOnlyHeader: true,
    headClassName: "w-12 text-right",
    skeleton: <Skeleton className="ml-auto size-7" />,
  },
];

/**
 * CRUD table for one category kind, used inside the Taxonomies tabs. Reads the kind's list hook and
 * picks the matching delete hook (all four are called unconditionally per the Rules of Hooks). The
 * shared `ResourceTable` / `RowActions` / `DeleteConfirmDialog` keep it consistent with the resource
 * lists; create/edit goes through {@link CategoryFormDialog}.
 */
export function CategoryManager({ kind }: { kind: CategoryKind }) {
  const assetQuery = useAssetCategories();
  const applicationQuery = useApplicationCategories();
  const consumableQuery = useConsumableCategories();
  const articleQuery = useArticleCategories();

  const deleteAsset = useDeleteAssetCategory();
  const deleteApplication = useDeleteApplicationCategory();
  const deleteConsumable = useDeleteConsumableCategory();
  const deleteArticle = useDeleteArticleCategory();

  const query = {
    asset: assetQuery,
    application: applicationQuery,
    consumable: consumableQuery,
    article: articleQuery,
  }[kind];
  const remove = {
    asset: deleteAsset,
    application: deleteApplication,
    consumable: deleteConsumable,
    article: deleteArticle,
  }[kind];

  const { data, isLoading, isError, error, refetch } = query;
  const hasOrder = kindHasOrder(kind);
  const label = CATEGORY_KIND_LABEL[kind];

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AnyCategory | undefined>(undefined);
  const [deleting, setDeleting] = useState<AnyCategory | undefined>(undefined);

  const columns = [
    ...BASE_COLUMNS,
    ...(hasOrder ? [ORDER_COLUMN] : []),
    ...TAIL_COLUMNS,
  ];

  function openCreate() {
    setEditing(undefined);
    setFormOpen(true);
  }

  function openEdit(category: AnyCategory) {
    setEditing(category);
    setFormOpen(true);
  }

  const categories = (data ?? []) as AnyCategory[];
  const hasData = categories.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button onClick={openCreate} size="sm">
          <PlusIcon />
          New {label}
        </Button>
      </div>

      {isLoading ? (
        <ResourceTable columns={columns} isLoading />
      ) : isError ? (
        <ErrorState
          title={`Could not load ${label} list`}
          onRetry={() => refetch()}
          error={error}
        />
      ) : !hasData ? (
        <EmptyState
          icon={TagIcon}
          title={`No ${label} entries yet`}
          description="Create one to start classifying records."
          action={
            <Button onClick={openCreate}>
              <PlusIcon />
              Create the first one
            </Button>
          }
        />
      ) : (
        <ResourceTable columns={columns}>
          {categories.map((category) => (
            <TableRow key={category.id}>
              <TableCell className="font-medium">{category.name}</TableCell>
              <TableCell
                className="max-w-[320px] truncate text-muted-foreground"
                title={category.description ?? undefined}
              >
                {category.description ?? "—"}
              </TableCell>
              {hasOrder ? (
                <TableCell className="text-muted-foreground tabular-nums">
                  {categoryOrder(category) ?? "—"}
                </TableCell>
              ) : null}
              <TableCell className="text-muted-foreground tabular-nums">
                {formatDate(category.updatedAt)}
              </TableCell>
              <TableCell className="text-right">
                <RowActions
                  onEdit={() => openEdit(category)}
                  onDelete={() => setDeleting(category)}
                />
              </TableCell>
            </TableRow>
          ))}
        </ResourceTable>
      )}

      <CategoryFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        kind={kind}
        category={editing}
      />
      {deleting ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined);
          }}
          entityLabel={label}
          name={deleting.name}
          onConfirm={() => remove.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
