"use client";

import { PlusIcon, TagIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
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
import { useApplicationCategories, useDeleteApplicationCategory } from "@/lib/api/hooks/use-application-categories";
import { useArticleCategories, useDeleteArticleCategory } from "@/lib/api/hooks/use-article-categories";
import { useAssetCategories, useDeleteAssetCategory } from "@/lib/api/hooks/use-asset-categories";
import { useConsumableCategories, useDeleteConsumableCategory } from "@/lib/api/hooks/use-consumable-categories";
import { useCan } from "@/lib/hooks/use-permissions";
import { formatDate } from "@/lib/utils/format";
import { CategoryFormDialog } from "./category-form-dialog";
import {
  type AnyCategory,
  type CategoryKind,
  categoryOrder,
  kindHasOrder,
} from "./taxonomy-types";

/**
 * CRUD table for one category kind, used inside the Taxonomies tabs. Reads the kind's list hook and
 * picks the matching delete hook (all four are called unconditionally per the Rules of Hooks). The
 * shared `ResourceTable` / `RowActions` / `DeleteConfirmDialog` keep it consistent with the resource
 * lists; create/edit goes through {@link CategoryFormDialog}.
 */
export function CategoryManager({ kind }: { kind: CategoryKind }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
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
  const label = t(`taxonomies.kindLabel.${kind}`);
  // The category CRUD endpoints are gated on category:write / category:delete (a clone is a create →
  // category:write). The surface lives behind the settings:manage AdminGate; these finer gates match
  // the backend per-affordance and fail closed while the permission set loads.
  const canWrite = useCan("category:write");
  const canDelete = useCan("category:delete");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AnyCategory | undefined>(undefined);
  const [cloning, setCloning] = useState<AnyCategory | undefined>(undefined);
  const [deleting, setDeleting] = useState<AnyCategory | undefined>(undefined);

  const columns: ResourceColumn[] = [
    {
      key: "name",
      header: t("taxonomies.categories.columns.name"),
      skeleton: <Skeleton className="h-4 w-40" />,
    },
    {
      key: "description",
      header: t("taxonomies.categories.columns.description"),
      skeleton: <Skeleton className="h-4 w-56" />,
    },
    ...(hasOrder
      ? [
          {
            key: "order",
            header: t("taxonomies.categories.columns.order"),
            headClassName: "w-20",
            skeleton: <Skeleton className="h-4 w-8" />,
          } satisfies ResourceColumn,
        ]
      : []),
    {
      key: "updated",
      header: t("taxonomies.categories.columns.updated"),
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

  function openCreate() {
    setEditing(undefined);
    setCloning(undefined);
    setFormOpen(true);
  }

  function openEdit(category: AnyCategory) {
    setCloning(undefined);
    setEditing(category);
    setFormOpen(true);
  }

  function openClone(category: AnyCategory) {
    setEditing(undefined);
    setCloning(category);
    setFormOpen(true);
  }

  const categories = (data ?? []) as AnyCategory[];
  const hasData = categories.length > 0;

  return (
    <div className="space-y-4">
      {canWrite ? (
        <div className="flex items-center justify-end">
          <Button onClick={openCreate} size="sm">
            <PlusIcon />
            {t("taxonomies.categories.newButton", { label })}
          </Button>
        </div>
      ) : null}

      {isLoading ? (
        <ResourceTable columns={columns} isLoading />
      ) : isError ? (
        <ErrorState
          title={t("taxonomies.categories.loadError", { label })}
          onRetry={() => refetch()}
          error={error}
        />
      ) : !hasData ? (
        <EmptyState
          icon={TagIcon}
          pillar="manage"
          title={t("taxonomies.categories.emptyTitle", { label })}
          description={t("taxonomies.categories.emptyDescription")}
          action={
            canWrite
              ? {
                  label: t("taxonomies.categories.emptyAction"),
                  onClick: openCreate,
                }
              : undefined
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
                {canWrite || canDelete ? (
                  <RowActions
                    onEdit={canWrite ? () => openEdit(category) : undefined}
                    onClone={canWrite ? () => openClone(category) : undefined}
                    onDelete={
                      canDelete ? () => setDeleting(category) : undefined
                    }
                  />
                ) : null}
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
        cloneSource={cloning}
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
