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
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { ArchivedToggle } from "@/components/archived-toggle";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PageHeader } from "@/components/page-header";
import {
  BatchActionBar,
  EmptyState,
  ErrorState,
  Pagination,
  ResourceCard,
  ResourceCardMeta,
  type ResourceColumn,
  ResourceTable,
  RestoreRowAction,
  RowActions,
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
import { TableCell, TableRow } from "@/components/ui/table";
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
import { notifyBatchResult } from "@/lib/api/notify-batch-result";
import { notifyError } from "@/lib/api/notify-error";
import { usePermissions } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import { formatDate } from "@/lib/utils/format";
import {
  AssetStatusBadge,
  formatAssetStatus,
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

const OWNERSHIP_LABEL: Record<OwnershipFilter, string> = {
  ALL: "Any",
  HAS: "Has owners",
  NONE: "No owners",
};

export default function AssetsPage() {
  const router = useRouter();
  const { canWrite, isAdmin } = usePermissions();
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

  // Multi-select over the currently visible rows — ADMIN-only (the API batch endpoints are too).
  const visibleIds = useMemo(() => rows.map((asset) => asset.id), [rows]);
  const selection = useRowSelection(visibleIds);
  const selectable = isAdmin;

  /** Run a batch mutation, toast the per-id outcome, and clear the selection. */
  async function runBatch(
    run: () => Promise<BatchResult>,
    labels: { noun: string; verb: string },
    fallback: string,
  ) {
    try {
      const result = await run();
      notifyBatchResult(result, labels);
      selection.clear();
    } catch (err) {
      notifyError(err, fallback);
    }
  }

  function handleRestoreRow(id: string, name: string) {
    restoreAsset.mutate(id, {
      onSuccess: () => toast.success(`${name} restored`),
      onError: (err) => notifyError(err, "Couldn't restore the asset"),
    });
  }

  const columns = useMemo<ResourceColumn[]>(
    () => [
      {
        key: "name",
        header: (
          <SortableHeader
            label="Name"
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
            label="Asset tag"
            active={sort === "assetTag"}
            direction={dir}
            onToggle={() => toggleSort("assetTag")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      { key: "model", header: "Model", skeleton: <Skeleton className="h-4 w-28" /> },
      {
        key: "category",
        header: "Category",
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      {
        key: "location",
        header: "Location",
        skeleton: <Skeleton className="h-4 w-24" />,
      },
      {
        key: "status",
        header: (
          <SortableHeader
            label="Status"
            active={sort === "status"}
            direction={dir}
            onToggle={() => toggleSort("status")}
          />
        ),
        skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
      },
      {
        key: "owners",
        header: "Owners",
        skeleton: <Skeleton className="size-6 rounded-full" />,
      },
      {
        key: "updated",
        header: (
          <SortableHeader
            label="Updated"
            active={sort === "updatedAt"}
            direction={dir}
            onToggle={() => toggleSort("updatedAt")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        headClassName: "w-12 text-right",
        skeleton: <Skeleton className="ml-auto size-7" />,
      },
    ],
    [sort, dir, toggleSort],
  );

  const total = page?.total ?? 0;
  const isEmpty = total === 0;

  const chips = [
    ...(q ? [{ key: "q", label: `Search: “${q}”`, onClear: () => setQ("") }] : []),
    ...(statusFilter !== "ALL"
      ? [
          {
            key: "status",
            label: `Status: ${formatAssetStatus(statusFilter)}`,
            onClear: () => setFilter("status", FILTER_DEFAULTS.status),
          },
        ]
      : []),
    ...(categoryFilter !== "ALL"
      ? [
          {
            key: "category",
            label: `Category: ${
              categories?.find((c) => c.id === categoryFilter)?.name ?? "—"
            }`,
            onClear: () => setFilter("category", FILTER_DEFAULTS.category),
          },
        ]
      : []),
    ...(locationFilter !== "ALL"
      ? [
          {
            key: "location",
            label: `Location: ${
              locations?.find((l) => l.id === locationFilter)?.name ?? "—"
            }`,
            onClear: () => setFilter("location", FILTER_DEFAULTS.location),
          },
        ]
      : []),
    ...(ownershipFilter !== "ALL"
      ? [
          {
            key: "ownership",
            label: `Owners: ${OWNERSHIP_LABEL[ownershipFilter]}`,
            onClear: () => setFilter("ownership", FILTER_DEFAULTS.ownership),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Assets"
        subtitle="Everything your team tracks and owns."
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
                  New asset
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
          title="Could not load assets"
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty && !filtersActive ? (
        <EmptyState
          icon={ServerStackIcon}
          title="No assets yet"
          description="Register your first asset to start tracking it."
          action={
            canWrite ? (
              <Button asChild>
                <Link href="/assets/new">
                  <PlusIcon />
                  Create your first asset
                </Link>
              </Button>
            ) : undefined
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
              label="Search assets"
              placeholder="Search by name, serial, tag…"
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
                <SelectItem value="ALL">All statuses</SelectItem>
                {AssetStatusSchema.options.map((status) => (
                  <SelectItem key={status} value={status}>
                    {formatAssetStatus(status)}
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
                <SelectItem value="ALL">All categories</SelectItem>
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
                <SelectItem value="ALL">All locations</SelectItem>
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
                <SelectItem value="ALL">Any ownership</SelectItem>
                <SelectItem value="HAS">Has owners</SelectItem>
                <SelectItem value="NONE">No owners</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ActiveFilters chips={chips} onClearAll={clearFilters} />

          <ResourceTable
            columns={columns}
            isFilteredEmpty={rows.length === 0}
            filteredEmptyMessage={
              archived
                ? "No archived assets."
                : "No assets match your filters."
            }
            filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
            selection={
              selectable
                ? {
                    enabled: true,
                    allSelected: selection.allSelected,
                    someSelected: selection.someSelected,
                    onToggleAll: selection.toggleAll,
                    selectAllLabel: "Select all assets on this page",
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
                selectLabel={`Select ${asset.name}`}
                meta={
                  <>
                    <ResourceCardMeta label="Asset tag">
                      <span className="font-mono">{asset.assetTag ?? "—"}</span>
                    </ResourceCardMeta>
                    <ResourceCardMeta label="Model">
                      {asset.model?.name ?? "—"}
                    </ResourceCardMeta>
                    <ResourceCardMeta label="Category">
                      {asset.model?.category ? (
                        <Badge variant="outline">
                          {asset.model.category.name}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </ResourceCardMeta>
                    <ResourceCardMeta label="Location">
                      {asset.location?.name ?? "—"}
                    </ResourceCardMeta>
                    <ResourceCardMeta label="Owners">
                      <StackedOwnerAvatars
                        assignments={asset.activeAssignments}
                      />
                    </ResourceCardMeta>
                    <ResourceCardMeta label="Updated">
                      {formatDate(asset.updatedAt)}
                    </ResourceCardMeta>
                  </>
                }
                actions={
                  archived ? (
                    isAdmin ? (
                      <RestoreRowAction
                        onRestore={() =>
                          handleRestoreRow(asset.id, asset.name)
                        }
                        disabled={restoreAsset.isPending}
                      />
                    ) : undefined
                  ) : canWrite ? (
                    <RowActions
                      onEdit={() => router.push(`/assets/${asset.id}/edit`)}
                      onClone={() => router.push(`/assets/${asset.id}/clone`)}
                      onDelete={() =>
                        setDeleting({ id: asset.id, name: asset.name })
                      }
                    />
                  ) : undefined
                }
              />
            ))}
          >
            {rows.map((asset) => (
              <TableRow
                key={asset.id}
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
                    label={`Select ${asset.name}`}
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
                    isAdmin ? (
                      <div className="flex justify-end">
                        <RestoreRowAction
                          onRestore={() =>
                            handleRestoreRow(asset.id, asset.name)
                          }
                          disabled={restoreAsset.isPending}
                        />
                      </div>
                    ) : null
                  ) : canWrite ? (
                    <RowActions
                      onEdit={() => router.push(`/assets/${asset.id}/edit`)}
                      onClone={() => router.push(`/assets/${asset.id}/clone`)}
                      onDelete={() =>
                        setDeleting({ id: asset.id, name: asset.name })
                      }
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </ResourceTable>

          <BatchActionBar
            count={selection.count}
            onClear={selection.clear}
            noun="asset"
          >
            {archived ? (
              <Button
                size="sm"
                onClick={() =>
                  runBatch(
                    () => batchRestore.mutateAsync(selection.selectedIds),
                    { noun: "asset", verb: "restored" },
                    "Couldn't restore the selected assets",
                  )
                }
                disabled={batchRestore.isPending}
              >
                <ArrowUturnLeftIcon />
                Restore
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
                      { noun: "asset", verb: "updated" },
                      "Couldn't update the selected assets",
                    )
                  }
                >
                  <SelectTrigger size="sm" className="w-40">
                    <SelectValue placeholder="Set status…" />
                  </SelectTrigger>
                  <SelectContent>
                    {AssetStatusSchema.options.map((status) => (
                      <SelectItem key={status} value={status}>
                        {formatAssetStatus(status)}
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
                      { noun: "asset", verb: "deleted" },
                      "Couldn't delete the selected assets",
                    )
                  }
                  disabled={batchDelete.isPending}
                >
                  <TrashIcon />
                  Delete
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
          entityLabel="asset"
          name={deleting.name}
          onConfirm={() => deleteAsset.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
