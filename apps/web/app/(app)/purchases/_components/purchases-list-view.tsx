"use client";

import { PlusIcon, ShoppingCartIcon } from "@heroicons/react/24/outline";
import {
  PURCHASE_ORDER_STATUSES,
  PurchaseOrderReceiptFilterSchema,
  type PurchaseOrderListItem,
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
import { TableCell, TableRow } from "@/components/ui/table";
import {
  useDeletePurchaseOrder,
  usePurchaseOrders,
  useRestorePurchaseOrder,
} from "@/lib/api/hooks/use-purchase-orders";
import { useSupplier } from "@/lib/api/hooks/use-suppliers";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useCan, usePermissions } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import {
  MoneyTotals,
  PurchaseStatusBadge,
  ReceiptSummary,
  usePurchaseTitle,
} from "./purchase-display";
import { PurchasesTabs } from "./purchases-tabs";
import {
  derivePurchaseParams,
  PURCHASE_FILTER_DEFAULTS as FILTER_DEFAULTS,
  PURCHASE_LIST_OPTIONS,
  receiptFilterLifted,
} from "./purchases-list-query";
import { SupplierCombobox } from "./supplier-combobox";

const LOADING_MOBILE_CHILDREN = <></>;

/** Receipt filter value → its label key under `purchases.list.receipt`. */
const RECEIPT_LABEL = {
  ALL: "all",
  PENDING: "pending",
  NONE: "none",
  PARTIAL: "partial",
  RECEIVED: "received",
  OVER: "over",
} as const;

/** Stored status → its label key under `purchases.status`. */
const STATUS_LABEL = { DRAFT: "draft", ORDERED: "ordered", CANCELLED: "cancelled" } as const;

/**
 * The Purchases list (ADR-0099, UX proposal §3.0): opens on the purchases still waiting for units, with
 * search, receipt / status / supplier filters, "x of y received" and totals per currency label. The
 * area is optional — an instance that never records a purchase sees an empty state that says so.
 */
export function PurchasesListView() {
  const t = useTranslations("purchases");
  const tStatus = useTranslations("purchases.status");
  const { date } = useFormatters();
  const router = useRouter();
  const titleOf = usePurchaseTitle();
  const { isAdmin } = usePermissions();
  const canWrite = useCan("purchaseOrder:write");
  const canDelete = useCan("purchaseOrder:delete");
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
  } = useListParams(PURCHASE_LIST_OPTIONS);

  const archived = isAdmin && filters.archived === "only";
  // The archived view and a Cancelled filter ignore the receipt filter (see `receiptFilterLifted`).
  const receiptLifted = receiptFilterLifted(filters, { isAdmin });
  const { data: page, isLoading, isFetching, isError, error, refetch } = usePurchaseOrders(
    derivePurchaseParams({ q, sort, dir, offset, limit, filters }, { isAdmin }),
  );
  const total = page?.total ?? 0;
  // The list opens filtered (pending units), so an empty page does not mean the area is empty. Only then
  // ask whether ANY purchase exists, to choose between the "optional feature" empty state and "none open".
  const probeEmpty = !isLoading && !isError && total === 0 && !filtersActive;
  const { data: anyPage, isLoading: anyLoading } = usePurchaseOrders(
    { limit: 1 },
    { enabled: probeEmpty },
  );
  const areaEmpty = probeEmpty && anyPage?.total === 0;

  const { data: supplierFilter } = useSupplier(
    filters.supplier !== "ALL" ? filters.supplier : undefined,
  );
  const deletePurchase = useDeletePurchaseOrder();
  const restorePurchase = useRestorePurchaseOrder();
  const [deleting, setDeleting] = useState<PurchaseOrderListItem | null>(null);

  const rows = useMemo(() => page?.items ?? [], [page?.items]);

  const columns = useMemo<ResourceColumn[]>(
    () => [
      {
        key: "purchase",
        header: (
          <SortableHeader
            label={t("list.columns.purchase")}
            active={sort === "reference"}
            direction={dir}
            onToggle={() => toggleSort("reference")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-36" />,
      },
      { key: "supplier", header: t("list.columns.supplier"), skeleton: <Skeleton className="h-4 w-24" /> },
      {
        key: "ordered",
        header: (
          <SortableHeader
            label={t("list.columns.ordered")}
            active={sort === "orderDate"}
            direction={dir}
            onToggle={() => toggleSort("orderDate")}
          />
        ),
        skeleton: <Skeleton className="h-4 w-20" />,
      },
      {
        key: "status",
        header: t("list.columns.status"),
        skeleton: <Skeleton className="h-5 w-20 rounded-sm" />,
      },
      { key: "received", header: t("list.columns.received"), skeleton: <Skeleton className="h-4 w-20" /> },
      { key: "total", header: t("list.columns.total"), skeleton: <Skeleton className="h-4 w-24" /> },
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

  function handleRestore(purchase: PurchaseOrderListItem) {
    restorePurchase.mutate(purchase.id, {
      onSuccess: () => toast.success(t("list.restored", { name: titleOf(purchase) })),
      onError: (err) => notifyError(err, t("list.restoreError")),
    });
  }

  function rowActions(purchase: PurchaseOrderListItem) {
    if (archived) {
      return canDelete ? (
        <RestoreRowAction
          onRestore={() => handleRestore(purchase)}
          disabled={restorePurchase.isPending}
        />
      ) : null;
    }
    if (!canWrite && !canDelete) return null;
    return (
      <RowActions
        onEdit={canWrite ? () => router.push(`/purchases/${purchase.id}/edit`) : undefined}
        onDelete={canDelete ? () => setDeleting(purchase) : undefined}
        deleteLabel={t("list.archive")}
      />
    );
  }

  const chips = [
    ...(q ? [{ key: "q", label: t("list.chips.search", { query: q }), onClear: () => setQ("") }] : []),
    ...(filters.receipt !== FILTER_DEFAULTS.receipt && !receiptLifted
      ? [
          {
            key: "receipt",
            label: t(`list.receipt.${RECEIPT_LABEL[filters.receipt as keyof typeof RECEIPT_LABEL]}`),
            onClear: () => setFilter("receipt", FILTER_DEFAULTS.receipt),
          },
        ]
      : []),
    ...(filters.status !== "ALL"
      ? [
          {
            key: "status",
            label: tStatus(STATUS_LABEL[filters.status as keyof typeof STATUS_LABEL]),
            onClear: () => setFilter("status", "ALL"),
          },
        ]
      : []),
    ...(filters.supplier !== "ALL"
      ? [
          {
            key: "supplier",
            label: t("list.chips.supplier", { name: supplierFilter?.name ?? "—" }),
            onClear: () => setFilter("supplier", "ALL"),
          },
        ]
      : []),
  ];

  const newPurchaseAction = canWrite ? (
    <Button asChild>
      <Link href="/purchases/new">
        <PlusIcon />
        {t("list.newPurchase")}
      </Link>
    </Button>
  ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("list.title")}
        pillar="inventory"
        icon={ShoppingCartIcon}
        subtitle={t("list.subtitle")}
        actions={
          <>
            {isAdmin ? (
              <ArchivedToggle
                checked={archived}
                onCheckedChange={(on) => setFilter("archived", on ? "only" : FILTER_DEFAULTS.archived)}
              />
            ) : null}
            {newPurchaseAction}
          </>
        }
      />
      <PurchasesTabs active="purchases" />

      {isLoading || (probeEmpty && anyLoading) ? (
        <ResourceTable columns={columns} isLoading mobileChildren={LOADING_MOBILE_CHILDREN} />
      ) : isError ? (
        <ErrorState title={t("list.loadError")} onRetry={() => refetch()} error={error} />
      ) : areaEmpty && !archived ? (
        <EmptyState
          icon={ShoppingCartIcon}
          pillar="inventory"
          title={t("empty.title")}
          description={t("empty.description")}
          action={canWrite ? { label: t("empty.action"), href: "/purchases/new" } : undefined}
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
            <SearchInput
              value={q}
              debounceMs={300}
              onDebouncedChange={setQ}
              label={t("list.searchLabel")}
              placeholder={t("list.searchPlaceholder")}
              className="lg:max-w-xs lg:flex-1"
            />
            <Select
              value={receiptLifted ? "ALL" : filters.receipt}
              onValueChange={(value) => setFilter("receipt", value)}
              disabled={receiptLifted}
            >
              <SelectTrigger className="lg:w-52" aria-label={t("list.receiptFilterLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["ALL", ...PurchaseOrderReceiptFilterSchema.options] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`list.receipt.${RECEIPT_LABEL[value]}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filters.status} onValueChange={(value) => setFilter("status", value)}>
              <SelectTrigger className="lg:w-40" aria-label={t("list.statusFilterLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("list.allStatuses")}</SelectItem>
                {PURCHASE_ORDER_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {tStatus(STATUS_LABEL[status])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <SupplierCombobox
              value={filters.supplier !== "ALL" ? filters.supplier : ""}
              onValueChange={(value) => setFilter("supplier", value || "ALL")}
              placeholder={t("list.allSuppliers")}
              className="lg:w-52"
            />
          </div>

          <ActiveFilters chips={chips} onClearAll={clearFilters} />

          <ResourceTable
            columns={columns}
            isFilteredEmpty={rows.length === 0}
            filteredEmptyMessage={
              archived
                ? t("list.archivedEmpty")
                : filtersActive
                  ? t("list.filteredEmpty")
                  : t("list.pendingEmpty")
            }
            filteredEmptyAction={
              filtersActive ? (
                <ClearFiltersLink onClick={clearFilters} />
              ) : (
                <Button variant="link" className="h-auto p-0" onClick={() => setFilter("receipt", "ALL")}>
                  {t("list.showAll")}
                </Button>
              )
            }
            mobileChildren={rows.map((purchase) => (
              <ResourceCard
                key={purchase.id}
                href={archived ? undefined : `/purchases/${purchase.id}`}
                title={titleOf(purchase)}
                badge={<PurchaseStatusBadge status={purchase.status} receipt={purchase.receipt} />}
                meta={
                  <>
                    <ResourceCardMeta label={t("list.columns.supplier")}>
                      {purchase.supplier?.name ?? "—"}
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("list.columns.received")}>
                      <ReceiptSummary receipt={purchase.receipt} />
                    </ResourceCardMeta>
                    <ResourceCardMeta label={t("list.columns.total")}>
                      <MoneyTotals totals={purchase.totals} />
                    </ResourceCardMeta>
                  </>
                }
                actions={rowActions(purchase) ?? undefined}
              />
            ))}
          >
            {rows.map((purchase) => {
              const title = titleOf(purchase);
              const href = `/purchases/${purchase.id}`;
              const cells = (
                <>
                  <TableCell className="font-medium">
                    {archived ? (
                      title
                    ) : (
                      <Link
                        href={href}
                        className={cn("hover:underline", !purchase.reference && "text-muted-foreground")}
                      >
                        {title}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>{purchase.supplier?.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="font-mono text-muted-foreground tabular-nums">
                    {purchase.orderDate ? date(purchase.orderDate) : "—"}
                  </TableCell>
                  <TableCell>
                    <PurchaseStatusBadge status={purchase.status} receipt={purchase.receipt} />
                  </TableCell>
                  <TableCell className="text-sm">
                    <ReceiptSummary receipt={purchase.receipt} />
                  </TableCell>
                  <TableCell className="text-sm">
                    <MoneyTotals totals={purchase.totals} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className={cn("flex justify-end", !archived && rowActionsReveal)}>
                      {rowActions(purchase)}
                    </div>
                  </TableCell>
                </>
              );
              return archived ? (
                <TableRow key={purchase.id}>{cells}</TableRow>
              ) : (
                <LinkableRow key={purchase.id} href={href}>
                  {cells}
                </LinkableRow>
              );
            })}
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
          entityKey="purchase"
          name={titleOf(deleting)}
          onConfirm={() => deletePurchase.mutateAsync(deleting.id)}
        >
          {t("list.archiveNote")}
        </DeleteConfirmDialog>
      ) : null}
    </div>
  );
}
