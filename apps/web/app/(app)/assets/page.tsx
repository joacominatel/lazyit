"use client";

import {
  ArrowUturnLeftIcon,
  PlusIcon,
  ServerStackIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  type AssetStatus,
  AssetStatusSchema,
  type BatchResult,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { ArchivedToggle } from "@/components/archived-toggle";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import {
  BatchActionBar,
  ErrorState,
  LinkableRow,
  Pagination,
  ResourceCard,
  ResourceCardMeta,
  type ResourceColumn,
  ResourceTable,
  RestoreRowAction,
  RowActions,
  rowActionsReveal,
  SelectCell,
  SortableHeader,
} from "@/components/resource-table";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell } from "@/components/ui/table";
import { useAssetCategories } from "@/lib/api/hooks/use-asset-categories";
import { useAssets } from "@/lib/api/hooks/use-assets";
import {
  useBatchDeleteAssets,
  useBatchRestoreAssets,
  useBatchSetAssetStatus,
  useDeleteAsset,
  useRestoreAsset,
} from "@/lib/api/hooks/use-asset-mutations";
import { useLocations } from "@/lib/api/hooks/use-locations";
import {
  type BatchVerb,
  notifyBatchResult,
} from "@/lib/api/notify-batch-result";
import { notifyError } from "@/lib/api/notify-error";
import type { EntityKey } from "@/lib/entity-key";
import { useCan, usePermissions } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/utils/format";
import {
  AssetStatusBadge,
  useAssetStatusLabel,
} from "./_components/asset-status-badge";
import { StackedOwnerAvatars } from "./_components/stacked-owner-avatars";

type OwnershipFilter = "ALL" | "HAS" | "NONE";

/**
 * Filter param defaults for the URL list-state. `status`/`category`/`location` map to the server's
 * `status`/`categoryId`/`locationId` params; `ownership` is filtered client-side over the page.
 * `archived` ("ALL" | "only") drives the ADMIN-only `deleted=only` view via the URL.
 */
const FILTER_DEFAULTS = {
  status: "ALL",
  category: "ALL",
  location: "ALL",
  ownership: "ALL",
  archived: "ALL",
} as const;

/** Maps each ownership filter to its label key under `assets.list.ownership`. */
const OWNERSHIP_LABEL_KEY: Record<OwnershipFilter, "any" | "has" | "none"> = {
  ALL: "any",
  HAS: "has",
  NONE: "none",
};

export default function AssetsPage() {
  const router = useRouter();
  const t = useTranslations("assets.list");
  const tEmpty = useTranslations("assets.empty");
  const tc = useTranslations("common");
  const tShared = useTranslations("shared");
  const statusLabel = useAssetStatusLabel();
  // `isAdmin` still gates the archived (`deleted=only`) slice: the API's `assertCanListDeleted` keeps
  // that view ADMIN-only (it was NOT migrated to a permission), so a MEMBER with asset:delete still
  // can't list archived rows. Write/delete affordances use the fine-grained permissions.
  const { isAdmin } = usePermissions();
  const canWrite = useCan("asset:write");
  const canDelete = useCan("asset:delete");
  const {
    q,
    sort,
    dir,
    offset,
    limit,
    filters,
    setQ,
    toggleSort,
    setFilter,
    setOffset,
    clearFilters,
    filtersActive,
  } = useListParams({
    filters: FILTER_DEFAULTS,
    defaultSort: "updatedAt",
    defaultDir: "desc",
  });

  const statusFilter = filters.status as AssetStatus | "ALL";
  const categoryFilter = filters.category;
  const locationFilter = filters.location;
  const ownershipFilter = filters.ownership as OwnershipFilter;
  // The archived view is ADMIN-only; a non-admin can never set it (toggle hidden) and we never send
  // the param for them, so the API stays on the active-only list.
  const archived = isAdmin && filters.archived === "only";

  // Forward server-supported params; `ownership` is filtered client-side over the page below.
  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useAssets({
      q: q || undefined,
      status: statusFilter === "ALL" ? undefined : statusFilter,
      categoryId: categoryFilter === "ALL" ? undefined : categoryFilter,
      locationId: locationFilter === "ALL" ? undefined : locationFilter,
      sort,
      dir: sort ? dir : undefined,
      limit,
      offset,
      deleted: archived ? "only" : undefined,
    });
  const { data: categories } = useAssetCategories();
  const { data: locations } = useLocations();
  const deleteAsset = useDeleteAsset();
  const restoreAsset = useRestoreAsset();
  const batchDelete = useBatchDeleteAssets();
  const batchRestore = useBatchRestoreAssets();
  const batchStatus = useBatchSetAssetStatus();

  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null,
  );

  const rows = useMemo(() => {
    const items = page?.items ?? [];
    return items.filter((asset) => {
      if (ownershipFilter === "HAS") return asset.activeAssignments.length > 0;
      if (ownershipFilter === "NONE") return asset.activeAssignments.length === 0;
      return true;
    });
  }, [page?.items, ownershipFilter]);

  // Multi-select over the currently visible rows — the API batch endpoints all require asset:delete
  // (bulk delete/restore/status are lifecycle ops), so gate the selection column on canDelete.
  const visibleIds = useMemo(() => rows.map((asset) => asset.id), [rows]);
  const selection = useRowSelection(visibleIds);
  const selectable = canDelete;

  /** Run a batch mutation, toast the per-id outcome, and clear the selection. */
  async function runBatch(
    run: () => Promise<BatchResult>,
    labels: { entityKey: EntityKey; verb: BatchVerb },
    fallback: string,
  ) {
    try {
      const result = await run();
      notifyBatchResult(result, { ...labels, t: tShared });
      selection.clear();
    } catch (err) {
      notifyError(err, fallback);
    }
  }

  function handleRestoreRow(id: string, name: string) {
    restoreAsset.mutate(id, {
      onSuccess: () => toast.success(t("restoredToast", { name })),
      onError: (err) => notifyError(err, t("restoreError")),
    });
  }

  const columns = useMemo<ResourceColumn[]>(
    () => [
      {
        key: "name",
        header: (
          <SortableHeader
            label={t("columns.name")}
            active={sort === "name"}
            direction={dir}
            onToggle={() => toggleSort("name")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-32" />,
      },
      {
        key: "assetTag",
        header: (
          <SortableHeader
            label={t("columns.assetTag")}
            active={sort === "assetTag"}
            direction={dir}
            onToggle={() => toggleSort("assetTag")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      {
        key: "model",
        header: t("columns.model"),
        skeleton: <Skeleton className="h-4 w-28" />,
      },
      {
        key: "category",
        header: t("columns.category"),
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      {
        key: "location",
        header: t("columns.location"),
        skeleton: <Skeleton className="h-4 w-24" />,
      },
      {
        key: "status",
        header: (
          <SortableHeader
            label={t("columns.status")}
            active={sort === "status"}
            direction={dir}
            onToggle={() => toggleSort("status")}
          />
        ),
        skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
      },
      {
        key: "owners",
        header: t("columns.owners"),
        skeleton: <Skeleton className="size-6 rounded-full" />,
      },
      {
        key: "updated",
        header: (
          <SortableHeader
            label={t("columns.updated")}
            active={sort === "updatedAt"}
            direction={dir}
            onToggle={() => toggleSort("updatedAt")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      {
        key: "actions",
        header: t("columns.actions"),
        srOnlyHeader: true,
        headClassName: "w-12 text-right",
        skeleton: <Skeleton className="ml-auto size-7" />,
      },
    ],
    [sort, dir, toggleSort, t],
  );

  const total = page?.total ?? 0;
  const isEmpty = total === 0;

  const chips = [
    ...(q
      ? [
          {
            key: "q",
            label: t("chips.search", { query: q }),
            onClear: () => setQ(""),
          },
        ]
      : []),
    ...(statusFilter !== "ALL"
      ? [
          {
            key: "status",
            label: t("chips.status", { value: statusLabel(statusFilter) }),
            onClear: () => setFilter("status", FILTER_DEFAULTS.status),
          },
        ]
      : []),
    ...(categoryFilter !== "ALL"
      ? [
          {
            key: "category",
            label: t("chips.category", {
              value:
                categories?.find((c) => c.id === categoryFilter)?.name ?? "—",
            }),
            onClear: () => setFilter("category", FILTER_DEFAULTS.category),
          },
        ]
      : []),
    ...(locationFilter !== "ALL"
      ? [
          {
            key: "location",
            label: t("chips.location", {
              value:
                locations?.find((l) => l.id === locationFilter)?.name ?? "—",
            }),
            onClear: () => setFilter("location", FILTER_DEFAULTS.location),
          },
        ]
      : []),
    ...(ownershipFilter !== "ALL"
      ? [
          {
            key: "ownership",
            label: t("chips.owners", {
              value: t(`ownership.${OWNERSHIP_LABEL_KEY[ownershipFilter]}`),
            }),
            onClear: () => setFilter("ownership", FILTER_DEFAULTS.ownership),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        pillar="inventory"
        icon={ServerStackIcon}
        subtitle={t("subtitle")}
        actions={
          <>
            {isAdmin ? (
              <ArchivedToggle
                checked={archived}
                onCheckedChange={(on) => {
                  setFilter("archived", on ? "only" : FILTER_DEFAULTS.archived);
                  selection.clear();
                }}
              />
            ) : null}
            {canWrite ? (
              <Button asChild>
                <Link href="/assets/new">
                  <PlusIcon />
                  {t("newAsset")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      {isLoading ? (
        <ResourceTable columns={columns} isLoading mobileChildren={<></>} />
      ) : isError ? (
        <ErrorState
          title={t("errorTitle")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty && !filtersActive ? (
        <EmptyState
          icon={ServerStackIcon}
          pillar="inventory"
          title={tEmpty("title")}
          description={tEmpty("description")}
          action={
            canWrite
              ? { label: tEmpty("action"), href: "/assets/new" }
              : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
            <SearchInput
              value={q}
              onChange={setQ}
              debounceMs={300}
              onDebouncedChange={setQ}
              label={t("searchLabel")}
              placeholder={t("searchPlaceholder")}
              className="lg:max-w-xs lg:flex-1"
            />
            <Select
              value={statusFilter}
              onValueChange={(value) => setFilter("status", value)}
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("filters.allStatuses")}</SelectItem>
                {AssetStatusSchema.options.map((status) => (
                  <SelectItem key={status} value={status}>
                    {statusLabel(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={categoryFilter}
              onValueChange={(value) => setFilter("category", value)}
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("filters.allCategories")}</SelectItem>
                {(categories ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={locationFilter}
              onValueChange={(value) => setFilter("location", value)}
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("filters.allLocations")}</SelectItem>
                {(locations ?? []).map((location) => (
                  <SelectItem key={location.id} value={location.id}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={ownershipFilter}
              onValueChange={(value) => setFilter("ownership", value)}
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("filters.anyOwnership")}</SelectItem>
                <SelectItem value="HAS">{t("filters.hasOwners")}</SelectItem>
                <SelectItem value="NONE">{t("filters.noOwners")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ActiveFilters chips={chips} onClearAll={clearFilters} />

          <ResourceTable
            columns={columns}
            isFilteredEmpty={rows.length === 0}
            filteredEmptyMessage={
              archived ? t("filteredEmptyArchived") : t("filteredEmpty")
            }
            filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
            selection={
              selectable
                ? {
                    enabled: true,
                    allSelected: selection.allSelected,
                    someSelected: selection.someSelected,
                    onToggleAll: selection.toggleAll,
                    selectAllLabel: t("selectAllLabel"),
                  }
                : undefined
            }
            mobileChildren={rows.map((asset) => (
              <ResourceCard
                key={asset.id}
                href={`/assets/${asset.id}`}
                title={asset.name}
                badge={<AssetStatusBadge status={asset.status} />}
                selectable={selectable}
                selected={selection.isSelected(asset.id)}
                onSelectedChange={(on) => selection.setSelected(asset.id, on)}
                selectLabel={t("selectRowLabel", { name: asset.name })}
                meta={
                  <>
                    <ResourceCardMeta label={t("columns.assetTag")}>
                      <span className="font-mono">{asset.assetTag ?? "—"}</span>
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.model")}>
                      {asset.model?.name ?? "—"}
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.category")}>
                      {asset.model?.category ? (
                        <Badge variant="outline">
                          {asset.model.category.name}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.location")}>
                      {asset.location?.name ?? "—"}
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.owners")}>
                      <StackedOwnerAvatars
                        assignments={asset.activeAssignments}
                      />
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.updated")}>
                      {formatDate(asset.updatedAt)}
                    </ResourceCardMeta>
                  </>
                }
                actions={
                  archived ? (
                    canDelete ? (
                      <RestoreRowAction
                        onRestore={() =>
                          handleRestoreRow(asset.id, asset.name)
                        }
                        disabled={restoreAsset.isPending}
                      />
                    ) : undefined
                  ) : canWrite || canDelete ? (
                    <RowActions
                      onEdit={
                        canWrite
                          ? () => router.push(`/assets/${asset.id}/edit`)
                          : undefined
                      }
                      onClone={
                        canWrite
                          ? () => router.push(`/assets/${asset.id}/clone`)
                          : undefined
                      }
                      onDelete={
                        canDelete
                          ? () => setDeleting({ id: asset.id, name: asset.name })
                          : undefined
                      }
                    />
                  ) : undefined
                }
              />
            ))}
          >
            {rows.map((asset) => (
              <LinkableRow
                key={asset.id}
                href={`/assets/${asset.id}`}
                data-state={
                  selectable && selection.isSelected(asset.id)
                    ? "selected"
                    : undefined
                }
              >
                {selectable ? (
                  <SelectCell
                    checked={selection.isSelected(asset.id)}
                    onCheckedChange={(on) =>
                      selection.setSelected(asset.id, on)
                    }
                    label={t("selectRowLabel", { name: asset.name })}
                  />
                ) : null}
                <TableCell className="font-medium">
                  <Link href={`/assets/${asset.id}`} className="hover:underline">
                    {asset.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {asset.assetTag ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {asset.model?.name ?? "—"}
                </TableCell>
                <TableCell>
                  {asset.model?.category ? (
                    <Badge variant="outline">{asset.model.category.name}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {asset.location?.name ?? "—"}
                </TableCell>
                <TableCell>
                  <AssetStatusBadge status={asset.status} />
                </TableCell>
                <TableCell>
                  <StackedOwnerAvatars assignments={asset.activeAssignments} />
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatDate(asset.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  {archived ? (
                    canDelete ? (
                      <div className="flex justify-end">
                        <RestoreRowAction
                          onRestore={() =>
                            handleRestoreRow(asset.id, asset.name)
                          }
                          disabled={restoreAsset.isPending}
                        />
                      </div>
                    ) : null
                  ) : canWrite || canDelete ? (
                    <div className={cn("flex justify-end", rowActionsReveal)}>
                      <RowActions
                        onEdit={
                          canWrite
                            ? () => router.push(`/assets/${asset.id}/edit`)
                            : undefined
                        }
                        onClone={
                          canWrite
                            ? () => router.push(`/assets/${asset.id}/clone`)
                            : undefined
                        }
                        onDelete={
                          canDelete
                            ? () => setDeleting({ id: asset.id, name: asset.name })
                            : undefined
                        }
                      />
                    </div>
                  ) : null}
                </TableCell>
              </LinkableRow>
            ))}
          </ResourceTable>

          <BatchActionBar
            count={selection.count}
            onClear={selection.clear}
            entityKey="asset"
          >
            {archived ? (
              <Button
                size="sm"
                onClick={() =>
                  runBatch(
                    () => batchRestore.mutateAsync(selection.selectedIds),
                    { entityKey: "asset", verb: "restored" },
                    t("batchRestoreError"),
                  )
                }
                disabled={batchRestore.isPending}
              >
                <ArrowUturnLeftIcon />
                {t("restore")}
              </Button>
            ) : (
              <>
                <Select
                  onValueChange={(value) =>
                    runBatch(
                      () =>
                        batchStatus.mutateAsync({
                          ids: selection.selectedIds,
                          status: value as AssetStatus,
                        }),
                      { entityKey: "asset", verb: "updated" },
                      t("batchStatusError"),
                    )
                  }
                >
                  <SelectTrigger size="sm" className="w-40">
                    <SelectValue placeholder={t("setStatusPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {AssetStatusSchema.options.map((status) => (
                      <SelectItem key={status} value={status}>
                        {statusLabel(status)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    runBatch(
                      () => batchDelete.mutateAsync(selection.selectedIds),
                      { entityKey: "asset", verb: "deleted" },
                      t("batchDeleteError"),
                    )
                  }
                  disabled={batchDelete.isPending}
                >
                  <TrashIcon />
                  {tc("delete")}
                </Button>
              </>
            )}
          </BatchActionBar>

          <Pagination
            total={total}
            limit={page?.limit ?? limit}
            offset={page?.offset ?? offset}
            itemCount={page?.items.length ?? 0}
            onOffsetChange={setOffset}
            isFetching={isFetching}
          />
        </>
      )}

      {deleting ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          entityKey="asset"
          name={deleting.name}
          onConfirm={() => deleteAsset.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
