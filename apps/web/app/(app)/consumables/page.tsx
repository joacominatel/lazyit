"use client";

import { CubeIcon, PlusIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PageHeader } from "@/components/page-header";
import {
  EmptyState,
  ErrorState,
  Pagination,
  ResourceCard,
  ResourceCardMeta,
  type ResourceColumn,
  ResourceTable,
  RowActions,
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
import { useConsumableCategories } from "@/lib/api/hooks/use-consumable-categories";
import { useConsumables } from "@/lib/api/hooks/use-consumables";
import { useDeleteConsumable } from "@/lib/api/hooks/use-consumable-mutations";
import { useCanWrite } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { formatDate } from "@/lib/utils/format";
import { QuickAdjustButtons } from "./_components/quick-adjust-buttons";
import { StockBadge } from "./_components/stock-badge";

/**
 * Filter param defaults. `lowStock` is a server filter ("true"); `category` is client-side over the
 * page (the API has no category param).
 */
const FILTER_DEFAULTS = { lowStock: "", category: "ALL" } as const;

export default function ConsumablesPage() {
  const router = useRouter();
  const canWrite = useCanWrite();
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

  const categoryFilter = filters.category;
  const lowStockOnly = filters.lowStock === "true";

  // Forward only the server-supported params (`q`/`sort`/`dir`/`lowStock` + the window). `category`
  // is filtered client-side over the page below.
  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useConsumables({
      q: q || undefined,
      sort,
      dir: sort ? dir : undefined,
      lowStock: lowStockOnly,
      limit,
      offset,
    });
  const { data: categories } = useConsumableCategories();
  const deleteConsumable = useDeleteConsumable();

  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null,
  );

  const categoryNameById = useMemo(
    () =>
      new Map((categories ?? []).map((category) => [category.id, category.name])),
    [categories],
  );

  const rows = useMemo(() => {
    const items = page?.items ?? [];
    return categoryFilter === "ALL"
      ? items
      : items.filter((consumable) => consumable.categoryId === categoryFilter);
  }, [page?.items, categoryFilter]);

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
        key: "category",
        header: "Category",
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      {
        key: "stock",
        header: (
          <SortableHeader
            label="Stock"
            active={sort === "currentStock"}
            direction={dir}
            onToggle={() => toggleSort("currentStock")}
          />
        ),
        skeleton: <Skeleton className="h-5 w-12 rounded-md" />,
      },
      { key: "unit", header: "Unit", skeleton: <Skeleton className="h-4 w-14" /> },
      {
        key: "sku",
        header: (
          <SortableHeader
            label="SKU"
            active={sort === "sku"}
            direction={dir}
            onToggle={() => toggleSort("sku")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-20" />,
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
        key: "quick-adjust",
        header: "Quick adjust",
        srOnlyHeader: true,
        headClassName: "w-24",
        skeleton: <Skeleton className="ml-auto h-7 w-16" />,
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

  function categoryBadge(categoryId: string | null) {
    return categoryId && categoryNameById.has(categoryId) ? (
      <Badge variant="outline">{categoryNameById.get(categoryId)}</Badge>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }

  const chips = [
    ...(q ? [{ key: "q", label: `Search: “${q}”`, onClear: () => setQ("") }] : []),
    ...(categoryFilter !== "ALL"
      ? [
          {
            key: "category",
            label: `Category: ${categoryNameById.get(categoryFilter) ?? "—"}`,
            onClear: () => setFilter("category", FILTER_DEFAULTS.category),
          },
        ]
      : []),
    ...(lowStockOnly
      ? [
          {
            key: "lowStock",
            label: "Low stock only",
            onClear: () => setFilter("lowStock", FILTER_DEFAULTS.lowStock),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Consumables"
        subtitle="Stock-counted supplies — cables, adapters, toner and the like."
        actions={
          canWrite ? (
            <Button asChild>
              <Link href="/consumables/new">
                <PlusIcon />
                New consumable
              </Link>
            </Button>
          ) : null
        }
      />

      {isLoading ? (
        <ResourceTable columns={columns} isLoading mobileChildren={<></>} />
      ) : isError ? (
        <ErrorState
          title="Could not load consumables"
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty && !filtersActive ? (
        <EmptyState
          icon={CubeIcon}
          title="No consumables yet"
          description="Add the supplies your team keeps in stock to start tracking quantities."
          action={
            canWrite ? (
              <Button asChild>
                <Link href="/consumables/new">
                  <PlusIcon />
                  Create your first consumable
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
              label="Search consumables"
              placeholder="Search by name or SKU…"
              className="lg:max-w-xs lg:flex-1"
            />
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
              value={lowStockOnly ? "LOW" : "ALL"}
              onValueChange={(value) =>
                setFilter("lowStock", value === "LOW" ? "true" : "")
              }
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All stock</SelectItem>
                <SelectItem value="LOW">Low stock only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ActiveFilters chips={chips} onClearAll={clearFilters} />

          <ResourceTable
            columns={columns}
            isFilteredEmpty={rows.length === 0}
            filteredEmptyMessage="No consumables match your filters."
            filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
            mobileChildren={rows.map((consumable) => (
              <ResourceCard
                key={consumable.id}
                href={`/consumables/${consumable.id}`}
                title={consumable.name}
                badge={
                  <StockBadge
                    currentStock={consumable.currentStock}
                    minStock={consumable.minStock}
                  />
                }
                meta={
                  <>
                    <ResourceCardMeta label="Category">
                      {categoryBadge(consumable.categoryId)}
                    </ResourceCardMeta>
                    <ResourceCardMeta label="Unit">
                      {consumable.unit}
                    </ResourceCardMeta>
                    <ResourceCardMeta label="SKU">
                      <span className="font-mono">{consumable.sku ?? "—"}</span>
                    </ResourceCardMeta>
                    <ResourceCardMeta label="Updated">
                      {formatDate(consumable.updatedAt)}
                    </ResourceCardMeta>
                  </>
                }
                actions={
                  canWrite ? (
                    <>
                      <QuickAdjustButtons
                        consumableId={consumable.id}
                        name={consumable.name}
                        currentStock={consumable.currentStock}
                        unit={consumable.unit}
                        size="sm"
                      />
                      <RowActions
                        onEdit={() =>
                          router.push(`/consumables/${consumable.id}/edit`)
                        }
                        onDelete={() =>
                          setDeleting({
                            id: consumable.id,
                            name: consumable.name,
                          })
                        }
                      />
                    </>
                  ) : undefined
                }
              />
            ))}
          >
            {rows.map((consumable) => (
              <TableRow key={consumable.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/consumables/${consumable.id}`}
                    className="hover:underline"
                  >
                    {consumable.name}
                  </Link>
                </TableCell>
                <TableCell>{categoryBadge(consumable.categoryId)}</TableCell>
                <TableCell>
                  <StockBadge
                    currentStock={consumable.currentStock}
                    minStock={consumable.minStock}
                  />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {consumable.unit}
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {consumable.sku ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatDate(consumable.updatedAt)}
                </TableCell>
                <TableCell>
                  {canWrite ? (
                    <div className="flex justify-end">
                      <QuickAdjustButtons
                        consumableId={consumable.id}
                        name={consumable.name}
                        currentStock={consumable.currentStock}
                        unit={consumable.unit}
                      />
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  {canWrite ? (
                    <RowActions
                      onEdit={() =>
                        router.push(`/consumables/${consumable.id}/edit`)
                      }
                      onDelete={() =>
                        setDeleting({ id: consumable.id, name: consumable.name })
                      }
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </ResourceTable>

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
          entityLabel="consumable"
          name={deleting.name}
          onConfirm={() => deleteConsumable.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
