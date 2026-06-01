"use client";

import {
  MagnifyingGlassIcon,
  PlusIcon,
  ServerStackIcon,
} from "@heroicons/react/24/outline";
import {
  type AssetListItem,
  type AssetStatus,
  AssetStatusSchema,
  DEFAULT_PAGE_LIMIT,
} from "@lazyit/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  EmptyState,
  ErrorState,
  Pagination,
  type ResourceColumn,
  ResourceTable,
  RowActions,
  type SortDirection,
  SortableHeader,
} from "@/components/resource-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useDeleteAsset } from "@/lib/api/hooks/use-asset-mutations";
import { useAssets } from "@/lib/api/hooks/use-assets";
import { useLocations } from "@/lib/api/hooks/use-locations";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { formatDate } from "@/lib/utils/format";
import { AssetStatusBadge, formatAssetStatus } from "./_components/asset-status-badge";
import { StackedOwnerAvatars } from "./_components/stacked-owner-avatars";

type StatusFilter = "ALL" | AssetStatus;
type OwnershipFilter = "ALL" | "HAS" | "NONE";

/** The columns that can be sorted client-side over the current page (ADR-0030: no server sort). */
type SortKey = "name" | "assetTag" | "status" | "updatedAt";

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

/**
 * Build the column set, wiring the sortable headers to the current sort state. Sorting is
 * client-side over the loaded page only (the `Page<T>` contract has no sort param, ADR-0030).
 */
function buildColumns(
  sort: SortState,
  onSort: (key: SortKey) => void,
): ResourceColumn[] {
  const sortable = (key: SortKey, label: string) => (
    <SortableHeader
      label={label}
      active={sort.key === key}
      direction={sort.direction}
      onToggle={() => onSort(key)}
    />
  );
  return [
    {
      key: "name",
      header: sortable("name", "Name"),
      skeleton: <Skeleton className="h-4 w-32" />,
    },
    {
      key: "assetTag",
      header: sortable("assetTag", "Asset tag"),
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
      header: sortable("status", "Status"),
      skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
    },
    {
      key: "owners",
      header: "Owners",
      skeleton: <Skeleton className="size-6 rounded-full" />,
    },
    {
      key: "updated",
      header: sortable("updatedAt", "Updated"),
      skeleton: <Skeleton className="h-4 w-20" />,
    },
    {
      key: "actions",
      header: "Actions",
      srOnlyHeader: true,
      headClassName: "w-12 text-right",
      skeleton: <Skeleton className="ml-auto size-7" />,
    },
  ];
}

/** Compare two assets on `key`; returns a sign for `Array.sort` (asc). */
function compareAssets(a: AssetListItem, b: AssetListItem, key: SortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "assetTag":
      return (a.assetTag ?? "").localeCompare(b.assetTag ?? "");
    case "status":
      return a.status.localeCompare(b.status);
    case "updatedAt":
      return a.updatedAt.localeCompare(b.updatedAt);
  }
}

export default function AssetsPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [locationFilter, setLocationFilter] = useState("ALL");
  const [ownershipFilter, setOwnershipFilter] = useState<OwnershipFilter>("ALL");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<SortState>({
    key: "updatedAt",
    direction: "desc",
  });
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null,
  );

  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  // Server-side filters that scope the result set; offset is threaded for paging (ADR-0030).
  const serverFilters = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      status: statusFilter === "ALL" ? undefined : statusFilter,
      categoryId: categoryFilter === "ALL" ? undefined : categoryFilter,
      locationId: locationFilter === "ALL" ? undefined : locationFilter,
    }),
    [debouncedSearch, statusFilter, categoryFilter, locationFilter],
  );

  // Any server-filter change is a different result set, so paging resets to the first page. We do
  // this during render (the "derive state from props" pattern) rather than in an effect, so the
  // reset and the new fetch happen in one pass — no extra render at a stale offset.
  const filterKey = JSON.stringify(serverFilters);
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setOffset(0);
  }

  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useAssets({ ...serverFilters, offset });
  const { data: categories } = useAssetCategories();
  const { data: locations } = useLocations();
  const deleteAsset = useDeleteAsset();

  const assets = page?.items;

  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );

  const columns = useMemo(
    () => buildColumns(sort, toggleSort),
    [sort],
  );

  // Ownership ("has / no active owners") is filtered, then the page is sorted — both client-side
  // over the current page only (the contract carries no sort param, ADR-0030).
  const filtered = useMemo(() => {
    const rows = (assets ?? []).filter((asset) => {
      if (ownershipFilter === "HAS") return asset.activeAssignments.length > 0;
      if (ownershipFilter === "NONE")
        return asset.activeAssignments.length === 0;
      return true;
    });
    const sorted = [...rows].sort((a, b) => compareAssets(a, b, sort.key));
    return sort.direction === "asc" ? sorted : sorted.reverse();
  }, [assets, ownershipFilter, sort]);

  const filtersActive =
    debouncedSearch !== "" ||
    statusFilter !== "ALL" ||
    categoryFilter !== "ALL" ||
    locationFilter !== "ALL" ||
    ownershipFilter !== "ALL";
  const isEmpty = (page?.total ?? 0) === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Assets</h1>
          <p className="text-sm text-muted-foreground">
            Everything your team tracks and owns.
          </p>
        </div>
        <Button asChild>
          <Link href="/assets/new">
            <PlusIcon />
            New asset
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <ResourceTable columns={columns} isLoading />
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
            <Button asChild>
              <Link href="/assets/new">
                <PlusIcon />
                Create your first asset
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
            <div className="relative lg:max-w-xs lg:flex-1">
              <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name, serial, tag…"
                className="pl-8"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as StatusFilter)}
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
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
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
            <Select value={locationFilter} onValueChange={setLocationFilter}>
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
              onValueChange={(value) =>
                setOwnershipFilter(value as OwnershipFilter)
              }
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

          <ResourceTable
            columns={columns}
            isFilteredEmpty={filtered.length === 0}
            filteredEmptyMessage="No assets match your filters."
          >
            {filtered.map((asset) => (
              <TableRow key={asset.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/assets/${asset.id}`}
                    className="hover:underline"
                  >
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
                  <RowActions
                    onEdit={() => router.push(`/assets/${asset.id}/edit`)}
                    onDelete={() =>
                      setDeleting({ id: asset.id, name: asset.name })
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </ResourceTable>

          <Pagination
            total={page?.total ?? 0}
            limit={page?.limit ?? DEFAULT_PAGE_LIMIT}
            offset={page?.offset ?? 0}
            itemCount={assets?.length ?? 0}
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
