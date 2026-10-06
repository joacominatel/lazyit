"use client";

import { InformationCircleIcon, PlusIcon } from "@heroicons/react/24/outline";
import {
  type AssetStatus,
  type AssetStatusLabel,
  AssetStatusSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
  AssetStatusBadge,
  AssetStatusSwatch,
  useAssetStatusLabel,
} from "@/app/(app)/assets/_components/asset-status-badge";
import { ArchivedToggle } from "@/components/archived-toggle";
import { Callout } from "@/components/callout";
import {
  ErrorState,
  type ResourceColumn,
  ResourceTable,
  RestoreRowAction,
  RowActions,
} from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
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

/**
 * Settings → Taxonomies → Statuses (ADR-0101, #1524): the custom asset statuses, grouped under the six
 * BUILT-IN statuses they map to. The built-ins are fixed group headers — never editable — so the mapping
 * is visible at a glance: every custom status is a name for one of them, and the built-in status is what
 * every rule reads. Custom statuses are optional; with none, the page explains them and offers to add one.
 *
 * Gates mirror the category managers: create/edit `category:write`, archive/restore `category:delete`;
 * the archived list is ADMIN-only (ADR-0041), like every archived view.
 */
export function AssetStatusLabelManager() {
  const t = useTranslations("settings.taxonomies.statuses");
  const tc = useTranslations("common");
  const statusLabel = useAssetStatusLabel();
  const canWrite = useCan("category:write");
  const canDelete = useCan("category:delete");
  const { isAdmin } = usePermissions();
  const [showArchived, setShowArchived] = useState(false);

  const { data, isLoading, isError, error, refetch } = useAssetStatusLabels();
  const archived = useArchivedAssetStatusLabels(isAdmin && showArchived);
  const restore = useRestoreAssetStatusLabel();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AssetStatusLabel | undefined>(undefined);
  const [newKind, setNewKind] = useState<AssetStatus | undefined>(undefined);
  const [archiving, setArchiving] = useState<AssetStatusLabel | null>(null);

  const labels = data ?? [];

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

  const columns: ResourceColumn[] = [
    { key: "name", header: t("columns.name"), skeleton: <Skeleton className="h-4 w-40" /> },
    {
      key: "description",
      header: t("columns.description"),
      skeleton: <Skeleton className="h-4 w-56" />,
    },
    {
      key: "order",
      header: t("columns.order"),
      headClassName: "w-20",
      skeleton: <Skeleton className="h-4 w-8" />,
    },
    {
      key: "assets",
      header: t("columns.assets"),
      headClassName: "w-24",
      skeleton: <Skeleton className="h-4 w-8" />,
    },
    {
      key: "actions",
      header: tc("actions"),
      srOnlyHeader: true,
      headClassName: "w-12 text-right",
      skeleton: <Skeleton className="ml-auto size-7" />,
    },
  ];

  return (
    <div className="space-y-4">
      <Callout tone="info" icon={<InformationCircleIcon />}>
        <p className="text-sm">{t("intro")}</p>
      </Callout>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {isAdmin ? (
          <ArchivedToggle
            id="statuses-show-archived"
            checked={showArchived}
            onCheckedChange={setShowArchived}
          />
        ) : (
          <span />
        )}
        {canWrite && !showArchived ? (
          <Button size="sm" onClick={() => openCreate()}>
            <PlusIcon />
            {t("newButton")}
          </Button>
        ) : null}
      </div>

      {showArchived ? (
        <ArchivedStatuses
          labels={archived.data}
          isLoading={archived.isLoading}
          isError={archived.isError}
          error={archived.error}
          onRetry={() => archived.refetch()}
          onRestore={canDelete ? handleRestore : undefined}
          restoring={restore.isPending}
        />
      ) : isLoading ? (
        <ResourceTable columns={columns} isLoading />
      ) : isError ? (
        <ErrorState title={t("loadError")} onRetry={() => refetch()} error={error} />
      ) : (
        <ResourceTable columns={columns}>
          {AssetStatusSchema.options.map((status) => {
            const group = labels.filter((label) => label.kind === status);
            return [
              <TableRow key={`group-${status}`} className="bg-muted/40 hover:bg-muted/40">
                <TableCell colSpan={columns.length}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <AssetStatusBadge status={status} />
                      <span className="text-xs text-muted-foreground">{t("builtIn")}</span>
                    </span>
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
                  </div>
                </TableCell>
              </TableRow>,
              ...group.map((label) => (
                <TableRow key={label.id}>
                  <TableCell className="pl-8 font-medium">
                    <span className="flex items-center gap-2">
                      <AssetStatusSwatch status={label.kind} color={label.color} className="size-2" />
                      {label.name}
                    </span>
                  </TableCell>
                  <TableCell
                    className="max-w-[320px] truncate text-muted-foreground"
                    title={label.description ?? undefined}
                  >
                    {label.description ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {label.order ?? "—"}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {(label.assetCount ?? 0) > 0 ? (
                      <Link
                        href={`/assets?statusLabel=${encodeURIComponent(label.id)}`}
                        className="underline-offset-4 hover:underline"
                        aria-label={t("assetsLink", {
                          count: label.assetCount ?? 0,
                          name: label.name,
                        })}
                      >
                        {label.assetCount}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {canWrite || canDelete ? (
                      <RowActions
                        onEdit={canWrite ? () => openEdit(label) : undefined}
                        onDelete={canDelete ? () => setArchiving(label) : undefined}
                        deleteLabel={t("archiveAction")}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              )),
            ];
          })}
        </ResourceTable>
      )}

      {!showArchived && !isLoading && !isError && labels.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : null}

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
  labels,
  isLoading,
  isError,
  error,
  onRetry,
  onRestore,
  restoring,
}: {
  labels: AssetStatusLabel[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  onRestore?: (label: AssetStatusLabel) => void;
  restoring: boolean;
}) {
  const t = useTranslations("settings.taxonomies.statuses");
  const tc = useTranslations("common");
  const kindName = useAssetStatusLabel();
  const { date } = useFormatters();
  const columns: ResourceColumn[] = [
    { key: "name", header: t("columns.name"), skeleton: <Skeleton className="h-4 w-40" /> },
    { key: "kind", header: t("columns.kind"), skeleton: <Skeleton className="h-4 w-24" /> },
    {
      key: "archived",
      header: t("columns.archived"),
      skeleton: <Skeleton className="h-4 w-20" />,
    },
    {
      key: "actions",
      header: tc("actions"),
      srOnlyHeader: true,
      headClassName: "w-28 text-right",
      skeleton: <Skeleton className="ml-auto h-7 w-20" />,
    },
  ];
  if (isLoading) return <ResourceTable columns={columns} isLoading />;
  if (isError) return <ErrorState title={t("loadError")} onRetry={onRetry} error={error} />;
  if (!labels || labels.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("archivedEmpty")}</p>;
  }
  return (
    <ResourceTable columns={columns}>
      {labels.map((label) => (
        <TableRow key={label.id}>
          <TableCell className="font-medium">
            <span className="flex items-center gap-2">
              <AssetStatusSwatch status={label.kind} color={label.color} className="size-2" />
              {label.name}
            </span>
          </TableCell>
          <TableCell className="text-muted-foreground">{kindName(label.kind)}</TableCell>
          <TableCell className="text-muted-foreground tabular-nums">
            {label.deletedAt ? date(label.deletedAt) : "—"}
          </TableCell>
          <TableCell className="text-right">
            {onRestore ? (
              <RestoreRowAction onRestore={() => onRestore(label)} disabled={restoring} />
            ) : null}
          </TableCell>
        </TableRow>
      ))}
    </ResourceTable>
  );
}
