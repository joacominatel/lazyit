"use client";

import { ArrowUturnLeftIcon, CubeIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { BatchResult } from "@lazyit/shared";
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
import { useConsumableCategories } from "@/lib/api/hooks/use-consumable-categories";
import { useConsumables } from "@/lib/api/hooks/use-consumables";
import {
  useDeleteConsumable,
  useRestoreConsumable,
} from "@/lib/api/hooks/use-consumable-mutations";
import { restoreConsumable } from "@/lib/api/endpoints/consumables";
import { notifyBatchResult } from "@/lib/api/notify-batch-result";
import { notifyError } from "@/lib/api/notify-error";
import { runPerIdBatch } from "@/lib/api/per-id-batch";
import { useCan, usePermissions } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/utils/format";
import { QuickAdjustButtons } from "./_components/quick-adjust-buttons";
import { StockBadge } from "./_components/stock-badge";

/**
 * Filter param defaults. `lowStock` is a server filter ("true"); `category` is client-side over the
 * page (the API has no category param). `archived` ("ALL" | "only") drives the ADMIN-only
 * `deleted=only` view via the URL.
 */
const FILTER_DEFAULTS = {
  lowStock: "",
  category: "ALL",
  archived: "ALL",
} as const;

export default function ConsumablesPage() {
  const t = useTranslations("consumables");
  const router = useRouter();
  // `isAdmin` still gates the archived (`deleted=only`) slice (API keeps it ADMIN-only). Create/edit/
  // quick-adjust are consumable:write; delete/restore are consumable:delete.
  const { isAdmin } = usePermissions();
  const canWrite = useCan("consumable:write");
  const canDelete = useCan("consumable:delete");
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
  // The archived view is ADMIN-only.
  const archived = isAdmin && filters.archived === "only";

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
      deleted: archived ? "only" : undefined,
    });
  const { data: categories } = useConsumableCategories();
  const deleteConsumable = useDeleteConsumable();
  const restoreConsumableMutation = useRestoreConsumable();

  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [bulkRestoring, setBulkRestoring] = useState(false);

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

  // Selection only matters in the archived view (the one place with a bulk action: Restore).
  const visibleIds = useMemo(() => rows.map((c) => c.id), [rows]);
  const selection = useRowSelection(visibleIds);
  const selectable = archived;

  function handleRestoreRow(id: string, name: string) {
    restoreConsumableMutation.mutate(id, {
      onSuccess: () => toast.success(t("list.restored", { name })),
      onError: (err) => notifyError(err, t("list.restoreRowError")),
    });
  }

  /** Bulk restore via a per-id fan-out (no consumable batch endpoint exists). */
  async function handleBulkRestore() {
    setBulkRestoring(true);
    try {
      const result: BatchResult = await runPerIdBatch(
        selection.selectedIds,
        restoreConsumable,
      );
      // The per-id calls bypass the mutation hook, so refetch the list explicitly via a no-op restore
      // is unnecessary — invalidate by re-running the query through the mutation's invalidator.
      notifyBatchResult(result, { noun: "consumable", verb: "restored" });
      selection.clear();
      await refetch();
    } catch (err) {
      notifyError(err, t("list.restoreSelectedError"));
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
            label={t("list.columns.name")}
            active={sort === "name"}
            direction={dir}
            onToggle={() => toggleSort("name")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-32" />,
      },
      {
        key: "category",
        header: t("list.columns.category"),
        skeleton: <Skeleton className="h-5 w-16 rounded-full" />,
      },
      {
        key: "stock",
        header: (
          <SortableHeader
            label={t("list.columns.stock")}
            active={sort === "currentStock"}
            direction={dir}
            onToggle={() => toggleSort("currentStock")}
          />
        ),
        skeleton: <Skeleton className="h-5 w-12 rounded-md" />,
      },
      {
        key: "unit",
        header: t("list.columns.unit"),
        skeleton: <Skeleton className="h-4 w-14" />,
      },
      {
        key: "sku",
        header: (
          <SortableHeader
            label={t("list.columns.sku")}
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
            label={t("list.columns.updated")}
            active={sort === "updatedAt"}
            direction={dir}
            onToggle={() => toggleSort("updatedAt")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      {
        key: "quick-adjust",
        header: t("list.columns.quickAdjust"),
        srOnlyHeader: true,
        headClassName: "w-24",
        skeleton: <Skeleton className="ml-auto h-7 w-16" />,
      },
      {
        key: "actions",
        header: t("list.columns.actions"),
        srOnlyHeader: true,
        headClassName: "w-12 text-right",
        skeleton: <Skeleton className="ml-auto size-7" />,
      },
    ],
    [sort, dir, toggleSort, t],
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
    ...(q
      ? [
          {
            key: "q",
            label: t("list.chips.search", { query: q }),
            onClear: () => setQ(""),
          },
        ]
      : []),
    ...(categoryFilter !== "ALL"
      ? [
          {
            key: "category",
            label: t("list.chips.category", {
              name: categoryNameById.get(categoryFilter) ?? "—",
            }),
            onClear: () => setFilter("category", FILTER_DEFAULTS.category),
          },
        ]
      : []),
    ...(lowStockOnly
      ? [
          {
            key: "lowStock",
            label: t("list.chips.lowStock"),
            onClear: () => setFilter("lowStock", FILTER_DEFAULTS.lowStock),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("list.title")}
        pillar="inventory"
        icon={CubeIcon}
        subtitle={t("list.subtitle")}
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
                <Link href="/consumables/new">
                  <PlusIcon />
                  {t("list.newConsumable")}
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
          title={t("list.loadError")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty && !filtersActive ? (
        <EmptyState
          icon={CubeIcon}
          pillar="inventory"
          title={t("empty.title")}
          description={t("empty.description")}
          action={
            canWrite
              ? { label: t("empty.action"), href: "/consumables/new" }
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
              label={t("list.searchLabel")}
              placeholder={t("list.searchPlaceholder")}
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
                <SelectItem value="ALL">{t("list.allCategories")}</SelectItem>
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
                <SelectItem value="ALL">{t("list.allStock")}</SelectItem>
                <SelectItem value="LOW">{t("list.lowStockOnly")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ActiveFilters chips={chips} onClearAll={clearFilters} />

          <ResourceTable
            columns={columns}
            isFilteredEmpty={rows.length === 0}
            filteredEmptyMessage={
              archived ? t("list.archivedEmpty") : t("list.filteredEmpty")
            }
            filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
            selection={
              selectable
                ? {
                    enabled: true,
                    allSelected: selection.allSelected,
                    someSelected: selection.someSelected,
                    onToggleAll: selection.toggleAll,
                    selectAllLabel: t("list.selectAllLabel"),
                  }
                : undefined
            }
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
                selectable={selectable}
                selected={selection.isSelected(consumable.id)}
                onSelectedChange={(on) =>
                  selection.setSelected(consumable.id, on)
                }
                selectLabel={t("list.selectRow", { name: consumable.name })}
                meta={
                  <>
                    <ResourceCardMeta label={t("list.meta.category")}>
                      {categoryBadge(consumable.categoryId)}
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("list.meta.unit")}>
                      {consumable.unit}
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("list.meta.sku")}>
                      <span className="font-mono">{consumable.sku ?? "—"}</span>
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("list.meta.updated")}>
                      {formatDate(consumable.updatedAt)}
                    </ResourceCardMeta>
                  </>
                }
                actions={
                  archived ? (
                    canDelete ? (
                      <RestoreRowAction
                        onRestore={() =>
                          handleRestoreRow(consumable.id, consumable.name)
                        }
                        disabled={restoreConsumableMutation.isPending}
                      />
                    ) : undefined
                  ) : canWrite || canDelete ? (
                    <>
                      {canWrite ? (
                        <QuickAdjustButtons
                          consumableId={consumable.id}
                          name={consumable.name}
                          currentStock={consumable.currentStock}
                          unit={consumable.unit}
                          size="sm"
                        />
                      ) : null}
                      <RowActions
                        onEdit={
                          canWrite
                            ? () =>
                                router.push(`/consumables/${consumable.id}/edit`)
                            : undefined
                        }
                        onClone={
                          canWrite
                            ? () =>
                                router.push(
                                  `/consumables/${consumable.id}/clone`,
                                )
                            : undefined
                        }
                        onDelete={
                          canDelete
                            ? () =>
                                setDeleting({
                                  id: consumable.id,
                                  name: consumable.name,
                                })
                            : undefined
                        }
                      />
                    </>
                  ) : undefined
                }
              />
            ))}
          >
            {rows.map((consumable) => (
              <LinkableRow
                key={consumable.id}
                href={`/consumables/${consumable.id}`}
                data-state={
                  selectable && selection.isSelected(consumable.id)
                    ? "selected"
                    : undefined
                }
              >
                {selectable ? (
                  <SelectCell
                    checked={selection.isSelected(consumable.id)}
                    onCheckedChange={(on) =>
                      selection.setSelected(consumable.id, on)
                    }
                    label={t("list.selectRow", { name: consumable.name })}
                  />
                ) : null}
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
                  {!archived && canWrite ? (
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
                  {archived ? (
                    canDelete ? (
                      <div className="flex justify-end">
                        <RestoreRowAction
                          onRestore={() =>
                            handleRestoreRow(consumable.id, consumable.name)
                          }
                          disabled={restoreConsumableMutation.isPending}
                        />
                      </div>
                    ) : null
                  ) : canWrite || canDelete ? (
                    <div className={cn("flex justify-end", rowActionsReveal)}>
                      <RowActions
                        onEdit={
                          canWrite
                            ? () =>
                                router.push(`/consumables/${consumable.id}/edit`)
                            : undefined
                        }
                        onClone={
                          canWrite
                            ? () =>
                                router.push(
                                  `/consumables/${consumable.id}/clone`,
                                )
                            : undefined
                        }
                        onDelete={
                          canDelete
                            ? () =>
                                setDeleting({
                                  id: consumable.id,
                                  name: consumable.name,
                                })
                            : undefined
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
              entityKey="consumable"
            >
              <Button
                size="sm"
                onClick={handleBulkRestore}
                disabled={bulkRestoring}
              >
                <ArrowUturnLeftIcon />
                {t("list.restore")}
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

      {deleting ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          entityKey="consumable"
          name={deleting.name}
          onConfirm={() => deleteConsumable.mutateAsync(deleting.id)}
        />
      ) : null}
    </div>
  );
}
