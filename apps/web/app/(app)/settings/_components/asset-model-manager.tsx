"use client";

import { PlusIcon } from "@heroicons/react/24/outline";
import type { AssetModel } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ErrorState, RowActions } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { useAssetCategories } from "@/lib/api/hooks/use-asset-categories";
import {
  useAssetModels,
  useDeleteAssetModel,
} from "@/lib/api/hooks/use-asset-models";
import { useCan } from "@/lib/hooks/use-permissions";
import { AssetModelFormDialog } from "./asset-model-form-dialog";
import {
  TaxonomyList,
  TaxonomyListSkeleton,
  TaxonomyNote,
  TaxonomyPaneHeader,
  TaxonomyRow,
  UsageText,
} from "./taxonomy-list";
import { filterTaxonomy } from "./taxonomy-usage";

/**
 * Asset models as a compact list (#1540): the model name, a muted "manufacturer · SKU · category" line,
 * how many assets use it (`usageCount`, nothing when absent) and a ⋯ menu (Edit / Duplicate / Delete).
 * Create and edit keep the full {@link AssetModelFormDialog} — a model has more required fields than a
 * name. Gates: `assetModel:write` (create, edit, duplicate) and `assetModel:delete`.
 */
export function AssetModelManager({ title }: { title: string }) {
  const t = useTranslations("settings");
  const { data, isLoading, isError, error, refetch } = useAssetModels();
  const { data: categories } = useAssetCategories();
  const remove = useDeleteAssetModel();
  const canWrite = useCan("assetModel:write");
  const canDelete = useCan("assetModel:delete");

  const [filter, setFilter] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AssetModel | undefined>(undefined);
  const [cloning, setCloning] = useState<AssetModel | undefined>(undefined);
  const [deleting, setDeleting] = useState<AssetModel | undefined>(undefined);

  const categoryName = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories ?? []) map.set(category.id, category.name);
    return map;
  }, [categories]);

  const models = useMemo(() => data ?? [], [data]);
  const detail = (model: AssetModel) =>
    [
      model.manufacturer,
      model.sku,
      model.categoryId ? categoryName.get(model.categoryId) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const visible = filterTaxonomy(models, filter, (m) => [
    m.name,
    m.manufacturer,
    m.sku,
    m.categoryId ? categoryName.get(m.categoryId) : null,
  ]);

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

  return (
    <div className="space-y-3">
      <TaxonomyPaneHeader
        title={title}
        filter={filter}
        onFilterChange={setFilter}
        actions={
          canWrite ? (
            <Button size="sm" onClick={openCreate}>
              <PlusIcon />
              {t("taxonomies.models.newButton")}
            </Button>
          ) : null
        }
      />

      {isLoading ? (
        <TaxonomyListSkeleton />
      ) : isError ? (
        <ErrorState
          title={t("taxonomies.models.loadError")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : (
        <TaxonomyList label={title}>
          {models.length === 0 ? (
            <TaxonomyNote>{t("taxonomies.models.empty")}</TaxonomyNote>
          ) : visible.length === 0 ? (
            <TaxonomyNote>{t("taxonomies.noMatches")}</TaxonomyNote>
          ) : (
            visible.map((model) => (
              <TaxonomyRow
                key={model.id}
                name={model.name}
                description={detail(model)}
                usage={<UsageText noun="assets" count={model.usageCount} />}
                actions={
                  canWrite || canDelete ? (
                    <RowActions
                      onEdit={canWrite ? () => openEdit(model) : undefined}
                      onClone={canWrite ? () => openClone(model) : undefined}
                      onDelete={canDelete ? () => setDeleting(model) : undefined}
                    />
                  ) : null
                }
              />
            ))
          )}
        </TaxonomyList>
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
