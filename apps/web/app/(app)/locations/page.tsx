"use client";

import {
  ArrowUturnLeftIcon,
  MapPinIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import {
  type BatchResult,
  type Location,
  type LocationType,
  LocationTypeSchema,
} from "@lazyit/shared";
import Link from "next/link";
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
import { useLocationList } from "@/lib/api/hooks/use-locations";
import {
  useDeleteLocation,
  useRestoreLocation,
} from "@/lib/api/hooks/use-location-mutations";
import { restoreLocation } from "@/lib/api/endpoints/locations";
import { notifyBatchResult } from "@/lib/api/notify-batch-result";
import { notifyError } from "@/lib/api/notify-error";
import { runPerIdBatch } from "@/lib/api/per-id-batch";
import { useCan, usePermissions } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/utils/format";
import { LocationFormDialog } from "./_components/location-form-dialog";
import {
  formatLocationType,
  LocationTypeBadge,
} from "./_components/location-type-badge";

/**
 * Filter param defaults for the URL list-state. `type` is filtered client-side over the page.
 * `archived` ("ALL" | "only") drives the ADMIN-only `deleted=only` view via the URL.
 */
const FILTER_DEFAULTS = { type: "ALL", archived: "ALL" } as const;

export default function LocationsPage() {
  // `isAdmin` still gates the archived (`deleted=only`) slice (API keeps it ADMIN-only). Create/edit
  // are location:write; delete/restore are location:delete.
  const { isAdmin } = usePermissions();
  const canWrite = useCan("location:write");
  const canDelete = useCan("location:delete");
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

  const typeFilter = filters.type as LocationType | "ALL";
  // The archived view is ADMIN-only.
  const archived = isAdmin && filters.archived === "only";

  // Forward only the server-supported params; `type` is filtered client-side over the page below.
  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useLocationList({
      q: q || undefined,
      sort,
      dir: sort ? dir : undefined,
      limit,
      offset,
      deleted: archived ? "only" : undefined,
    });
  const deleteLocation = useDeleteLocation();
  const restoreLocationMutation = useRestoreLocation();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Location | undefined>(undefined);
  const [deleting, setDeleting] = useState<Location | undefined>(undefined);
  const [bulkRestoring, setBulkRestoring] = useState(false);

  const rows = useMemo(() => {
    const items = page?.items ?? [];
    return typeFilter === "ALL"
      ? items
      : items.filter((location) => location.type === typeFilter);
  }, [page?.items, typeFilter]);

  // Selection only matters in the archived view (its sole bulk action: Restore).
  const visibleIds = useMemo(() => rows.map((loc) => loc.id), [rows]);
  const selection = useRowSelection(visibleIds);
  const selectable = archived;

  function handleRestoreRow(location: Location) {
    restoreLocationMutation.mutate(location.id, {
      onSuccess: () => toast.success(`${location.name} restored`),
      onError: (err) => notifyError(err, "Couldn't restore the location"),
    });
  }

  /** Bulk restore via a per-id fan-out (no location batch endpoint exists). */
  async function handleBulkRestore() {
    setBulkRestoring(true);
    try {
      const result: BatchResult = await runPerIdBatch(
        selection.selectedIds,
        restoreLocation,
      );
      notifyBatchResult(result, { noun: "location", verb: "restored" });
      selection.clear();
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't restore the selected locations");
    } finally {
      setBulkRestoring(false);
    }
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
        skeleton: <Skeleton className="h-4 w-40" />,
      },
      {
        key: "type",
        header: (
          <SortableHeader
            label="Type"
            active={sort === "type"}
            direction={dir}
            onToggle={() => toggleSort("type")}
          />
        ),
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      { key: "floor", header: "Floor", skeleton: <Skeleton className="h-4 w-10" /> },
      {
        key: "address",
        header: "Address",
        skeleton: <Skeleton className="h-4 w-48" />,
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

  function openCreate() {
    setEditing(undefined);
    setFormOpen(true);
  }

  function openEdit(location: Location) {
    setEditing(location);
    setFormOpen(true);
  }

  const chips = [
    ...(q ? [{ key: "q", label: `Search: “${q}”`, onClear: () => setQ("") }] : []),
    ...(typeFilter !== "ALL"
      ? [
          {
            key: "type",
            label: `Type: ${formatLocationType(typeFilter)}`,
            onClear: () => setFilter("type", FILTER_DEFAULTS.type),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Locations"
        pillar="manage"
        icon={MapPinIcon}
        subtitle="Where your assets physically live."
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
              <Button onClick={openCreate}>
                <PlusIcon />
                New location
              </Button>
            ) : null}
          </>
        }
      />

      {isLoading ? (
        <ResourceTable columns={columns} isLoading mobileChildren={<></>} />
      ) : isError ? (
        <ErrorState
          title="Could not load locations"
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty && !filtersActive ? (
        <EmptyState
          icon={MapPinIcon}
          pillar="manage"
          title="No locations yet"
          description="Add the offices, floors and storage rooms where assets live — then place each asset on the map of your estate."
          action={
            canWrite
              ? { label: "Add your first location", onClick: openCreate }
              : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SearchInput
              value={q}
              onChange={setQ}
              debounceMs={300}
              onDebouncedChange={setQ}
              label="Search locations"
              placeholder="Search by name…"
              className="sm:max-w-xs sm:flex-1"
            />
            <Select
              value={typeFilter}
              onValueChange={(value) => setFilter("type", value)}
            >
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All types</SelectItem>
                {LocationTypeSchema.options.map((type) => (
                  <SelectItem key={type} value={type}>
                    {formatLocationType(type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ActiveFilters chips={chips} onClearAll={clearFilters} />

          <ResourceTable
            columns={columns}
            isFilteredEmpty={rows.length === 0}
            filteredEmptyMessage={
              archived
                ? "No archived locations."
                : "No locations match your filters."
            }
            filteredEmptyAction={
              <ClearFiltersLink onClick={clearFilters} />
            }
            selection={
              selectable
                ? {
                    enabled: true,
                    allSelected: selection.allSelected,
                    someSelected: selection.someSelected,
                    onToggleAll: selection.toggleAll,
                    selectAllLabel: "Select all locations on this page",
                  }
                : undefined
            }
            mobileChildren={rows.map((location) => (
              <ResourceCard
                key={location.id}
                href={`/locations/${location.id}`}
                title={location.name}
                badge={<LocationTypeBadge type={location.type} />}
                selectable={selectable}
                selected={selection.isSelected(location.id)}
                onSelectedChange={(on) =>
                  selection.setSelected(location.id, on)
                }
                selectLabel={`Select ${location.name}`}
                meta={
                  <>
                    <ResourceCardMeta label="Floor">
                      {location.floor ?? "—"}
                    </ResourceCardMeta>
                    <ResourceCardMeta label="Updated">
                      {formatDate(location.updatedAt)}
                    </ResourceCardMeta>
                    {location.address ? (
                      <ResourceCardMeta label="Address" className="col-span-2">
                        {location.address}
                      </ResourceCardMeta>
                    ) : null}
                  </>
                }
                actions={
                  archived ? (
                    canDelete ? (
                      <RestoreRowAction
                        onRestore={() => handleRestoreRow(location)}
                        disabled={restoreLocationMutation.isPending}
                      />
                    ) : undefined
                  ) : canWrite || canDelete ? (
                    <RowActions
                      onEdit={canWrite ? () => openEdit(location) : undefined}
                      onDelete={
                        canDelete ? () => setDeleting(location) : undefined
                      }
                    />
                  ) : undefined
                }
              />
            ))}
          >
            {rows.map((location) => (
              <LinkableRow
                key={location.id}
                href={`/locations/${location.id}`}
                data-state={
                  selectable && selection.isSelected(location.id)
                    ? "selected"
                    : undefined
                }
              >
                {selectable ? (
                  <SelectCell
                    checked={selection.isSelected(location.id)}
                    onCheckedChange={(on) =>
                      selection.setSelected(location.id, on)
                    }
                    label={`Select ${location.name}`}
                  />
                ) : null}
                <TableCell className="font-medium">
                  <Link
                    href={`/locations/${location.id}`}
                    className="hover:underline"
                  >
                    {location.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <LocationTypeBadge type={location.type} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {location.floor ?? "—"}
                </TableCell>
                <TableCell
                  className="max-w-[220px] truncate text-muted-foreground"
                  title={location.address ?? undefined}
                >
                  {location.address ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatDate(location.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  {archived ? (
                    canDelete ? (
                      <div className="flex justify-end">
                        <RestoreRowAction
                          onRestore={() => handleRestoreRow(location)}
                          disabled={restoreLocationMutation.isPending}
                        />
                      </div>
                    ) : null
                  ) : canWrite || canDelete ? (
                    <div className={cn("flex justify-end", rowActionsReveal)}>
                      <RowActions
                        onEdit={canWrite ? () => openEdit(location) : undefined}
                        onDelete={
                          canDelete ? () => setDeleting(location) : undefined
                        }
                      />
                    </div>
                  ) : null}
                </TableCell>
              </LinkableRow>
            ))}
          </ResourceTable>

          {archived ? (
            <BatchActionBar
              count={selection.count}
              onClear={selection.clear}
              noun="location"
            >
              <Button
                size="sm"
                onClick={handleBulkRestore}
                disabled={bulkRestoring}
              >
                <ArrowUturnLeftIcon />
                Restore
              </Button>
            </BatchActionBar>
          ) : null}

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

      <LocationFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        location={editing}
      />
      {deleting ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined);
          }}
          entityLabel="location"
          name={deleting.name}
          onConfirm={() => deleteLocation.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
