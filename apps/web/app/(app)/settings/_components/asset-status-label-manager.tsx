"use client";

import { PlusIcon } from "@heroicons/react/24/outline";
import {
  type AssetStatus,
  type AssetStatusLabel,
  AssetStatusSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  AssetStatusBadge,
  AssetStatusSwatch,
  useAssetStatusLabel,
} from "@/app/(app)/assets/_components/asset-status-badge";
import { ArchivedToggle } from "@/components/archived-toggle";
import {
  ErrorState,
  RestoreRowAction,
  RowActions,
} from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import {
  useArchivedAssetStatusLabels,
  useAssetStatusLabels,
  useRestoreAssetStatusLabel,
} from "@/lib/api/hooks/use-asset-status-labels";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan, usePermissions } from "@/lib/hooks/use-permissions";
import { AssetStatusLabelArchiveDialog } from "./asset-status-label-archive-dialog";
import { AssetStatusLabelFormDialog } from "./asset-status-label-form-dialog";
import {
  TaxonomyGroupRow,
  TaxonomyList,
  TaxonomyListSkeleton,
  TaxonomyNote,
  TaxonomyPaneHeader,
  TaxonomyRow,
  UsageText,
} from "./taxonomy-list";
import { filterTaxonomy } from "./taxonomy-usage";

/**
 * Settings → Taxonomies → Custom statuses (ADR-0101, #1524, #1540): the custom asset statuses as compact
 * rows, grouped under the six BUILT-IN statuses they map to. The built-ins are fixed group rows — never
 * editable — each with "Add" for a custom status under it. A row shows its swatch, name, the
 * description muted when there is one, how many assets carry it (a link to them) and a ⋯ menu (Edit /
 * Archive). Archive keeps its dialog, which moves the assets first when any use the status.
 *
 * Gates mirror the category managers: create/edit `category:write`, archive/restore `category:delete`;
 * the archived list is ADMIN-only (ADR-0041), like every archived view.
 */
export function AssetStatusLabelManager({ title }: { title: string }) {
  const t = useTranslations("settings.taxonomies.statuses");
  const tt = useTranslations("settings.taxonomies");
  const statusLabel = useAssetStatusLabel();
  const canWrite = useCan("category:write");
  const canDelete = useCan("category:delete");
  const { isAdmin } = usePermissions();
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState("");

  const { data, isLoading, isError, error, refetch } = useAssetStatusLabels();
  const archived = useArchivedAssetStatusLabels(isAdmin && showArchived);
  const restore = useRestoreAssetStatusLabel();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AssetStatusLabel | undefined>(undefined);
  const [newKind, setNewKind] = useState<AssetStatus | undefined>(undefined);
  const [archiving, setArchiving] = useState<AssetStatusLabel | null>(null);

  const labels = data ?? [];
  const visible = filterTaxonomy(labels, filter, (l) => [l.name, l.description]);
  const filtering = filter.trim().length > 0;

  function openCreate(kind?: AssetStatus) {
    setEditing(undefined);
    setNewKind(kind);
    setFormOpen(true);
  }

  function openEdit(label: AssetStatusLabel) {
    setNewKind(undefined);
    setEditing(label);
    setFormOpen(true);
  }

  function handleRestore(label: AssetStatusLabel) {
    restore.mutate(label.id, {
      onSuccess: () => toast.success(t("toast.restored", { name: label.name })),
      onError: (err) => notifyError(err, t("toast.restoreError")),
    });
  }

  return (
    <div className="space-y-3">
      <TaxonomyPaneHeader
        title={title}
        help={<p>{t("intro")}</p>}
        filter={filter}
        onFilterChange={setFilter}
        actions={
          <>
            {isAdmin ? (
              <ArchivedToggle
                id="statuses-show-archived"
                checked={showArchived}
                onCheckedChange={setShowArchived}
              />
            ) : null}
            {canWrite && !showArchived ? (
              <Button size="sm" onClick={() => openCreate()}>
                <PlusIcon />
                {t("newButton")}
              </Button>
            ) : null}
          </>
        }
      />

      {showArchived ? (
        <ArchivedStatuses
          title={title}
          filter={filter}
          labels={archived.data}
          isLoading={archived.isLoading}
          isError={archived.isError}
          error={archived.error}
          onRetry={() => archived.refetch()}
          onRestore={canDelete ? handleRestore : undefined}
          restoring={restore.isPending}
        />
      ) : isLoading ? (
        <TaxonomyListSkeleton />
      ) : isError ? (
        <ErrorState title={t("loadError")} onRetry={() => refetch()} error={error} />
      ) : (
        <TaxonomyList label={title}>
          {filtering && visible.length === 0 ? (
            <TaxonomyNote>{tt("noMatches")}</TaxonomyNote>
          ) : null}
          {AssetStatusSchema.options.flatMap((status) => {
            const group = visible.filter((label) => label.kind === status);
            if (filtering && group.length === 0) return [];
            return [
              <TaxonomyGroupRow key={`group-${status}`}>
                <AssetStatusBadge status={status} />
                <span className="flex-1 text-xs text-muted-foreground">{t("builtIn")}</span>
                {canWrite ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openCreate(status)}
                    aria-label={t("addTo", { status: statusLabel(status) })}
                  >
                    <PlusIcon />
                    <span className="sr-only sm:not-sr-only">{t("add")}</span>
                  </Button>
                ) : null}
              </TaxonomyGroupRow>,
              ...group.map((label) => (
                <TaxonomyRow
                  key={label.id}
                  className="pl-8"
                  leading={
                    <AssetStatusSwatch status={label.kind} color={label.color} className="size-2" />
                  }
                  name={label.name}
                  description={label.description}
                  usage={
                    <UsageText
                      noun="assets"
                      count={label.assetCount}
                      href={`/assets?statusLabel=${encodeURIComponent(label.id)}`}
                      linkLabel={t("assetsLink", {
                        count: label.assetCount ?? 0,
                        name: label.name,
                      })}
                    />
                  }
                  actions={
                    canWrite || canDelete ? (
                      <RowActions
                        onEdit={canWrite ? () => openEdit(label) : undefined}
                        onDelete={canDelete ? () => setArchiving(label) : undefined}
                        deleteLabel={t("archiveAction")}
                      />
                    ) : null
                  }
                />
              )),
            ];
          })}
          {!filtering && labels.length === 0 ? <TaxonomyNote>{t("empty")}</TaxonomyNote> : null}
        </TaxonomyList>
      )}

      <AssetStatusLabelFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        label={editing}
        defaultKind={newKind}
      />
      {archiving ? (
        <AssetStatusLabelArchiveDialog
          label={archiving}
          liveLabels={labels}
          onOpenChange={(open) => {
            if (!open) setArchiving(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** The archived custom statuses (ADMIN), each with Restore — it comes back with no assets. */
function ArchivedStatuses({
  title,
  filter,
  labels,
  isLoading,
  isError,
  error,
  onRetry,
  onRestore,
  restoring,
}: {
  title: string;
  filter: string;
  labels: AssetStatusLabel[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  onRestore?: (label: AssetStatusLabel) => void;
  restoring: boolean;
}) {
  const t = useTranslations("settings.taxonomies.statuses");
  const tt = useTranslations("settings.taxonomies");
  const kindName = useAssetStatusLabel();
  const { date } = useFormatters();
  if (isLoading) return <TaxonomyListSkeleton />;
  if (isError) return <ErrorState title={t("loadError")} onRetry={onRetry} error={error} />;
  const all = labels ?? [];
  const visible = filterTaxonomy(all, filter, (l) => [l.name, l.description]);
  return (
    <TaxonomyList label={t("archivedLabel", { taxonomy: title })}>
      {all.length === 0 ? (
        <TaxonomyNote>{t("archivedEmpty")}</TaxonomyNote>
      ) : visible.length === 0 ? (
        <TaxonomyNote>{tt("noMatches")}</TaxonomyNote>
      ) : (
        visible.map((label) => (
          <li key={label.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
            <AssetStatusSwatch status={label.kind} color={label.color} className="size-2" />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{label.name}</span>{" "}
              <span className="text-xs text-muted-foreground">{kindName(label.kind)}</span>
            </span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {label.deletedAt ? t("archivedOn", { date: date(label.deletedAt) }) : null}
            </span>
            {onRestore ? (
              <RestoreRowAction onRestore={() => onRestore(label)} disabled={restoring} />
            ) : null}
          </li>
        ))
      )}
    </TaxonomyList>
  );
}
