"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  BatchActionBar,
  ErrorState,
  RowActions,
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  useApplicationCategories,
  useCreateApplicationCategory,
  useDeleteApplicationCategory,
} from "@/lib/api/hooks/use-application-categories";
import {
  useAssetCategories,
  useCreateAssetCategory,
  useDeleteAssetCategory,
} from "@/lib/api/hooks/use-asset-categories";
import {
  useConsumableCategories,
  useCreateConsumableCategory,
  useDeleteConsumableCategory,
} from "@/lib/api/hooks/use-consumable-categories";
import { notifyError } from "@/lib/api/notify-error";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import { useCan } from "@/lib/hooks/use-permissions";
import { CategoryFormDialog } from "./category-form-dialog";
import {
  InlineCreateRow,
  TaxonomyList,
  TaxonomyListSkeleton,
  TaxonomyNote,
  TaxonomyPaneHeader,
  TaxonomyRow,
  UsageText,
} from "./taxonomy-list";
import type { AnyCategory, CategoryKind } from "./taxonomy-types";
import { filterTaxonomy, type UsageNoun } from "./taxonomy-usage";

/** The category kinds Settings → Taxonomies manages. KB folders (the `article` kind) live in the KB. */
export type ManagedCategoryKind = Exclude<CategoryKind, "article">;

/** What each kind's `usageCount` counts. */
const USAGE_NOUN: Record<ManagedCategoryKind, UsageNoun> = {
  asset: "assets",
  application: "apps",
  consumable: "consumables",
};

/**
 * One category kind as a compact list (#1540): name (description muted, only when present), the "In
 * use" count from the list read's `usageCount` (nothing when the API sends none), a ⋯ menu with Edit /
 * Duplicate / Delete, and an inline "New category…" row. Edit and Duplicate open the full
 * {@link CategoryFormDialog} (description, icon, order, the asset specs dictionary).
 *
 * Bulk delete stays: "Select" turns on a checkbox per row and the batch bar (gated on
 * `category:delete`, as before). Gates: create/edit/duplicate `category:write`, delete
 * `category:delete` — the same per-affordance gates the API enforces, fail-closed while loading.
 */
export function CategoryManager({ kind, title }: { kind: ManagedCategoryKind; title: string }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const queries = {
    asset: useAssetCategories(),
    application: useApplicationCategories(),
    consumable: useConsumableCategories(),
  };
  const deletes = {
    asset: useDeleteAssetCategory(),
    application: useDeleteApplicationCategory(),
    consumable: useDeleteConsumableCategory(),
  };
  const creates = {
    asset: useCreateAssetCategory(),
    application: useCreateApplicationCategory(),
    consumable: useCreateConsumableCategory(),
  };
  const { data, isLoading, isError, error, refetch } = queries[kind];
  const remove = deletes[kind];
  const create = creates[kind];
  const label = t(`taxonomies.kindLabel.${kind}`);
  const canWrite = useCan("category:write");
  const canDelete = useCan("category:delete");

  const [filter, setFilter] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AnyCategory | undefined>(undefined);
  const [cloning, setCloning] = useState<AnyCategory | undefined>(undefined);
  const [deleting, setDeleting] = useState<AnyCategory | undefined>(undefined);
  const [selecting, setSelecting] = useState(false);

  const categories = useMemo(() => (data ?? []) as AnyCategory[], [data]);
  const visible = useMemo(
    () => filterTaxonomy(categories, filter, (c) => [c.name, c.description]),
    [categories, filter],
  );
  const visibleIds = useMemo(() => visible.map((c) => c.id), [visible]);
  const selection = useRowSelection(visibleIds);
  const selectable = canDelete && selecting;
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

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

  function stopSelecting() {
    selection.clear();
    setSelecting(false);
  }

  async function createNamed(name: string) {
    try {
      await create.mutateAsync({ name } as never);
      toast.success(t("taxonomies.categories.toast.created", { label }));
    } catch (err) {
      notifyError(err, t("taxonomies.categories.toast.createError", { label }));
      throw err;
    }
  }

  /**
   * Loop the per-kind delete over the selection (no batch endpoint). A category still in use answers
   * 409 and is intentionally KEPT — a partial success is the correct outcome. Deleted rows are
   * deselected; skipped rows stay selected so the operator can see them; a toast reports the split.
   */
  async function handleBulkDelete() {
    const ids = selection.selectedIds;
    if (ids.length === 0) return;
    setIsBulkDeleting(true);
    const results = await Promise.allSettled(ids.map((id) => remove.mutateAsync(id)));
    let deleted = 0;
    let skipped = 0;
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deleted += 1;
        selection.setSelected(ids[index], false);
      } else {
        skipped += 1;
      }
    });
    setIsBulkDeleting(false);
    setBulkConfirmOpen(false);
    const tb = (key: string, values?: Record<string, number>) =>
      t(`taxonomies.categories.bulkDelete.${key}`, values);
    if (skipped === 0) toast.success(tb("resultAllDeleted", { deleted }));
    else if (deleted === 0) toast.error(tb("resultAllSkipped", { skipped }));
    else toast.success(tb("resultPartial", { deleted, skipped }));
  }

  return (
    <div className="space-y-3">
      <TaxonomyPaneHeader
        title={title}
        filter={filter}
        onFilterChange={setFilter}
        actions={
          canDelete && categories.length > 0 ? (
            selecting ? (
              <Button variant="ghost" size="sm" onClick={stopSelecting}>
                {t("taxonomies.selectDone")}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setSelecting(true)}>
                <CheckCircleIcon />
                {t("taxonomies.select")}
              </Button>
            )
          ) : null
        }
      />

      {isLoading ? (
        <TaxonomyListSkeleton />
      ) : isError ? (
        <ErrorState
          title={t("taxonomies.categories.loadError", { label })}
          onRetry={() => refetch()}
          error={error}
        />
      ) : (
        <TaxonomyList
          label={title}
          footer={
            canWrite ? (
              <InlineCreateRow
                placeholder={t("taxonomies.categories.inlinePlaceholder")}
                label={t("taxonomies.categories.newButton", { label })}
                onCreate={createNamed}
              />
            ) : null
          }
        >
          {selectable && visible.length > 0 ? (
            <li className="flex items-center gap-3 bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={
                  selection.allSelected ? true : selection.someSelected ? "indeterminate" : false
                }
                onCheckedChange={() => selection.toggleAll(!selection.allSelected)}
                aria-label={t("taxonomies.categories.selectAll", { label })}
              />
              {t("taxonomies.selectAllVisible")}
            </li>
          ) : null}
          {categories.length === 0 ? (
            <TaxonomyNote>{t("taxonomies.categories.empty")}</TaxonomyNote>
          ) : visible.length === 0 ? (
            <TaxonomyNote>{t("taxonomies.noMatches")}</TaxonomyNote>
          ) : (
            visible.map((category) => (
              <TaxonomyRow
                key={category.id}
                selected={selectable && selection.isSelected(category.id)}
                leading={
                  selectable ? (
                    <Checkbox
                      checked={selection.isSelected(category.id)}
                      onCheckedChange={(on) => selection.setSelected(category.id, on === true)}
                      aria-label={t("taxonomies.categories.selectRow", { name: category.name })}
                    />
                  ) : null
                }
                name={category.name}
                description={category.description}
                usage={
                  <UsageText
                    noun={USAGE_NOUN[kind]}
                    count={"usageCount" in category ? category.usageCount : undefined}
                  />
                }
                actions={
                  canWrite || canDelete ? (
                    <RowActions
                      onEdit={canWrite ? () => openEdit(category) : undefined}
                      onClone={canWrite ? () => openClone(category) : undefined}
                      onDelete={canDelete ? () => setDeleting(category) : undefined}
                    />
                  ) : null
                }
              />
            ))
          )}
        </TaxonomyList>
      )}

      {selectable ? (
        <BatchActionBar count={selection.count} onClear={selection.clear} entityKey="category">
          <Button size="sm" variant="destructive" onClick={() => setBulkConfirmOpen(true)}>
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

      <AlertDialog
        open={bulkConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !isBulkDeleting) setBulkConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("taxonomies.categories.bulkDelete.confirmTitle", { count: selection.count })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("taxonomies.categories.bulkDelete.confirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBulkDeleting}>{tc("cancel")}</AlertDialogCancel>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={isBulkDeleting}>
              {isBulkDeleting && <ArrowPathIcon className="animate-spin" />}
              {tc("delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
