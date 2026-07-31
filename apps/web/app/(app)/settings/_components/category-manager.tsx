"use client";

import {
  ArrowPathIcon,
  PlusIcon,
  TagIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  BatchActionBar,
  ErrorState,
  type ResourceColumn,
  ResourceTable,
  RowActions,
  SelectCell,
} from "@/components/resource-table";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import { useApplicationCategories, useDeleteApplicationCategory } from "@/lib/api/hooks/use-application-categories";
import { useArticleCategories, useDeleteArticleCategory } from "@/lib/api/hooks/use-article-categories";
import { useAssetCategories, useDeleteAssetCategory } from "@/lib/api/hooks/use-asset-categories";
import { useConsumableCategories, useDeleteConsumableCategory } from "@/lib/api/hooks/use-consumable-categories";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
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
  const { date } = useFormatters();
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

  // ── Multi-select + bulk delete (KB/Settings UX batch) ────────────────────────────────────────
  // Copies the resource-list precedent (assets/users): `useRowSelection` over the visible rows feeds
  // ResourceTable's `selection` prop + a `BatchActionBar`. The bulk action is a lifecycle op, so the
  // whole thing is gated on `category:delete` — when the caller can't delete, `selection` is omitted
  // and the checkbox column never renders. DELETE is the only bulk action for v1; merge/move is a
  // deliberate follow-up (see follow_ups).
  // Derive from the query's `data` (stable identity), not the per-render `categories` array, so the
  // memo actually memoizes.
  const visibleIds = useMemo(
    () => ((data ?? []) as AnyCategory[]).map((c) => c.id),
    [data],
  );
  const selection = useRowSelection(visibleIds);
  const selectable = canDelete;
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  /**
   * Loop the EXISTING per-kind delete over the selected ids client-side (no batch endpoint). A
   * category that still has live articles/children 409s and is intentionally KEPT — a partial success
   * is the CORRECT outcome here, not an error. Succeeded rows are deselected (they'll drop out on the
   * list's invalidation); the skipped rows stay selected so the operator can see and re-target them,
   * and a summary toast reports the split.
   */
  async function handleBulkDelete() {
    const ids = selection.selectedIds;
    if (ids.length === 0) return;
    setIsBulkDeleting(true);
    const results = await Promise.allSettled(
      ids.map((id) => remove.mutateAsync(id)),
    );
    let deleted = 0;
    let skipped = 0;
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deleted += 1;
        // Clear only what actually went; a rejected (in-use → 409) row stays selected.
        selection.setSelected(ids[index], false);
      } else {
        skipped += 1;
      }
    });
    setIsBulkDeleting(false);
    setBulkConfirmOpen(false);
    const tb = (key: string, values?: Record<string, number>) =>
      t(`taxonomies.categories.bulkDelete.${key}`, values);
    if (skipped === 0) {
      toast.success(tb("resultAllDeleted", { deleted }));
    } else if (deleted === 0) {
      toast.error(tb("resultAllSkipped", { skipped }));
    } else {
      toast.success(tb("resultPartial", { deleted, skipped }));
    }
  }

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
        <ResourceTable
          columns={columns}
          selection={
            selectable
              ? {
                  enabled: true,
                  allSelected: selection.allSelected,
                  someSelected: selection.someSelected,
                  onToggleAll: selection.toggleAll,
                  selectAllLabel: t("taxonomies.categories.selectAll", {
                    label,
                  }),
                }
              : undefined
          }
        >
          {categories.map((category) => (
            <TableRow
              key={category.id}
              data-state={
                selectable && selection.isSelected(category.id)
                  ? "selected"
                  : undefined
              }
            >
              {selectable ? (
                <SelectCell
                  checked={selection.isSelected(category.id)}
                  onCheckedChange={(on) =>
                    selection.setSelected(category.id, on)
                  }
                  label={t("taxonomies.categories.selectRow", {
                    name: category.name,
                  })}
                />
              ) : null}
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
                {date(category.updatedAt)}
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

      {/* Batch-action bar for the current selection (self-hides at 0). A single confirm dialog gates
          the whole batch; the loop-delete + partial-success summary live in `handleBulkDelete`. */}
      {selectable ? (
        <BatchActionBar
          count={selection.count}
          onClear={selection.clear}
          entityKey="category"
        >
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setBulkConfirmOpen(true)}
          >
            <TrashIcon />
            {tc("delete")}
          </Button>
        </BatchActionBar>
      ) : null}

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
          entityKey="category"
          name={deleting.name}
          onConfirm={() => remove.mutateAsync(deleting.id)}
        />
      ) : null}

      {/* One confirm for the whole batch (not per-row). A plain destructive Button (not
          AlertDialogAction) so we own the spinner and only close on completion — mirrors the
          per-row DeleteConfirmDialog. `handleBulkDelete` reports the deleted/skipped split. */}
      <AlertDialog
        open={bulkConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !isBulkDeleting) setBulkConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("taxonomies.categories.bulkDelete.confirmTitle", {
                count: selection.count,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("taxonomies.categories.bulkDelete.confirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBulkDeleting}>
              {tc("cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={isBulkDeleting}
            >
              {isBulkDeleting && <ArrowPathIcon className="animate-spin" />}
              {tc("delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
