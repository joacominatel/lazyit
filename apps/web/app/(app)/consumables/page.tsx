"use client";

import { CubeIcon, MagnifyingGlassIcon, PlusIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  EmptyState,
  ErrorState,
  type ResourceColumn,
  ResourceTable,
  RowActions,
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
import { useConsumableCategories } from "@/lib/api/hooks/use-consumable-categories";
import { useDeleteConsumable } from "@/lib/api/hooks/use-consumable-mutations";
import { useConsumables } from "@/lib/api/hooks/use-consumables";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { formatDate } from "@/lib/utils/format";
import { StockBadge } from "./_components/stock-badge";

type StockFilter = "ALL" | "LOW";

const COLUMNS: ResourceColumn[] = [
  { key: "name", header: "Name", skeleton: <Skeleton className="h-4 w-32" /> },
  {
    key: "category",
    header: "Category",
    skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
  },
  {
    key: "stock",
    header: "Stock",
    skeleton: <Skeleton className="h-5 w-12 rounded-md" />,
  },
  { key: "unit", header: "Unit", skeleton: <Skeleton className="h-4 w-14" /> },
  { key: "sku", header: "SKU", skeleton: <Skeleton className="h-4 w-20" /> },
  { key: "updated", header: "Updated", skeleton: <Skeleton className="h-4 w-20" /> },
  {
    key: "actions",
    header: "Actions",
    srOnlyHeader: true,
    headClassName: "w-12 text-right",
    skeleton: <Skeleton className="ml-auto size-7" />,
  },
];

export default function ConsumablesPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [stockFilter, setStockFilter] = useState<StockFilter>("ALL");
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null,
  );

  const debouncedSearch = useDebouncedValue(search.trim().toLowerCase(), 300);

  // `lowStock` is a server filter; search + category are applied client-side over the result.
  const {
    data: consumables,
    isLoading,
    isError,
    error,
    refetch,
  } = useConsumables({ lowStock: stockFilter === "LOW" });
  const { data: categories } = useConsumableCategories();
  const deleteConsumable = useDeleteConsumable();

  const categoryNameById = useMemo(
    () => new Map((categories ?? []).map((category) => [category.id, category.name])),
    [categories],
  );

  const filtered = useMemo(
    () =>
      (consumables ?? []).filter((consumable) => {
        if (
          debouncedSearch &&
          !consumable.name.toLowerCase().includes(debouncedSearch) &&
          !(consumable.sku ?? "").toLowerCase().includes(debouncedSearch)
        )
          return false;
        if (categoryFilter !== "ALL" && consumable.categoryId !== categoryFilter)
          return false;
        return true;
      }),
    [consumables, debouncedSearch, categoryFilter],
  );

  const filtersActive =
    debouncedSearch !== "" || categoryFilter !== "ALL" || stockFilter !== "ALL";
  const isEmpty = (consumables?.length ?? 0) === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Consumables</h1>
          <p className="text-sm text-muted-foreground">
            Stock-counted supplies — cables, adapters, toner and the like.
          </p>
        </div>
        <Button asChild>
          <Link href="/consumables/new">
            <PlusIcon />
            New consumable
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <ResourceTable columns={COLUMNS} isLoading />
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
            <Button asChild>
              <Link href="/consumables/new">
                <PlusIcon />
                Create your first consumable
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
                placeholder="Search by name or SKU…"
                className="pl-8"
              />
            </div>
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
            <Select
              value={stockFilter}
              onValueChange={(value) => setStockFilter(value as StockFilter)}
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

          <ResourceTable
            columns={COLUMNS}
            isFilteredEmpty={filtered.length === 0}
            filteredEmptyMessage="No consumables match your filters."
          >
            {filtered.map((consumable) => (
              <TableRow key={consumable.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/consumables/${consumable.id}`}
                    className="hover:underline"
                  >
                    {consumable.name}
                  </Link>
                </TableCell>
                <TableCell>
                  {consumable.categoryId &&
                  categoryNameById.has(consumable.categoryId) ? (
                    <Badge variant="outline">
                      {categoryNameById.get(consumable.categoryId)}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
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
                <TableCell className="text-right">
                  <RowActions
                    onEdit={() =>
                      router.push(`/consumables/${consumable.id}/edit`)
                    }
                    onDelete={() =>
                      setDeleting({ id: consumable.id, name: consumable.name })
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </ResourceTable>
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
