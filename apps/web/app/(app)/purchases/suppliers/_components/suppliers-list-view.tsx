"use client";

import { BuildingStorefrontIcon, PlusIcon, ShoppingCartIcon } from "@heroicons/react/24/outline";
import type { Supplier } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
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
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  useDeleteSupplier,
  useRestoreSupplier,
  useSuppliers,
} from "@/lib/api/hooks/use-suppliers";
import { notifyError } from "@/lib/api/notify-error";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useCan, usePermissions } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { PurchasesTabs } from "../../_components/purchases-tabs";
import { SupplierFormDialog } from "./supplier-form-dialog";

const LOADING_MOBILE_CHILDREN = <></>;
const SUPPLIER_LIST_OPTIONS = {
  filters: { archived: "ALL" },
  defaultSort: "name",
  defaultDir: "asc" as const,
};

/** "Name · email · phone" of a contact, or `null` when none of it is set. */
function contactLine(name: string | null, email: string | null, phone: string | null): string | null {
  const parts = [name, email, phone].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The supplier directory (ADR-0099 §2): who the team buys from, with sales and support contacts. */
export function SuppliersListView() {
  const t = useTranslations("purchases.suppliers");
  const tArea = useTranslations("purchases");
  const { isAdmin } = usePermissions();
  const canWrite = useCan("purchaseOrder:write");
  const canDelete = useCan("purchaseOrder:delete");
  const { q, sort, dir, offset, limit, filters, setQ, toggleSort, setFilter, setOffset, clearFilters, filtersActive } =
    useListParams(SUPPLIER_LIST_OPTIONS);
  const archived = isAdmin && filters.archived === "only";
  const { data: page, isLoading, isFetching, isError, error, refetch } = useSuppliers({
    q: q || undefined,
    sort,
    dir: sort ? dir : undefined,
    limit,
    offset,
    deleted: archived ? "only" : undefined,
  });
  const deleteSupplier = useDeleteSupplier();
  const restoreSupplier = useRestoreSupplier();
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  const [deleting, setDeleting] = useState<Supplier | null>(null);

  const rows = useMemo(() => page?.items ?? [], [page?.items]);
  const total = page?.total ?? 0;

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
      { key: "taxId", header: t("columns.taxId"), skeleton: <Skeleton className="h-4 w-24" /> },
      { key: "sales", header: t("columns.salesContact"), skeleton: <Skeleton className="h-4 w-40" /> },
      { key: "support", header: t("columns.supportContact"), skeleton: <Skeleton className="h-4 w-40" /> },
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

  function rowActions(supplier: Supplier) {
    if (archived) {
      return canDelete ? (
        <RestoreRowAction
          onRestore={() =>
            restoreSupplier.mutate(supplier.id, {
              onSuccess: () => toast.success(t("restored", { name: supplier.name })),
              onError: (err) => notifyError(err, t("restoreError")),
            })
          }
          disabled={restoreSupplier.isPending}
        />
      ) : null;
    }
    if (!canWrite && !canDelete) return null;
    return (
      <RowActions
        onEdit={canWrite ? () => setEditing(supplier) : undefined}
        onDelete={canDelete ? () => setDeleting(supplier) : undefined}
        deleteLabel={t("archive")}
      />
    );
  }

  const chips = q ? [{ key: "q", label: tArea("list.chips.search", { query: q }), onClear: () => setQ("") }] : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={tArea("list.title")}
        pillar="inventory"
        icon={ShoppingCartIcon}
        subtitle={t("subtitle")}
        actions={
          <>
            {isAdmin ? (
              <ArchivedToggle
                checked={archived}
                onCheckedChange={(on) => setFilter("archived", on ? "only" : "ALL")}
              />
            ) : null}
            {canWrite ? (
              <Button onClick={() => setEditing("new")}>
                <PlusIcon />
                {t("newSupplier")}
              </Button>
            ) : null}
          </>
        }
      />
      <PurchasesTabs active="suppliers" />

      {isLoading ? (
        <ResourceTable columns={columns} isLoading mobileChildren={LOADING_MOBILE_CHILDREN} />
      ) : isError ? (
        <ErrorState title={t("loadError")} onRetry={() => refetch()} error={error} />
      ) : total === 0 && !filtersActive ? (
        <EmptyState
          icon={BuildingStorefrontIcon}
          pillar="inventory"
          title={t("empty.title")}
          description={t("empty.description")}
          action={canWrite ? { label: t("newSupplier"), onClick: () => setEditing("new") } : undefined}
        />
      ) : (
        <>
          <SearchInput
            value={q}
            debounceMs={300}
            onDebouncedChange={setQ}
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            className="lg:max-w-xs"
          />
          <ActiveFilters chips={chips} onClearAll={clearFilters} />
          <ResourceTable
            columns={columns}
            isFilteredEmpty={rows.length === 0}
            filteredEmptyMessage={archived ? t("archivedEmpty") : t("filteredEmpty")}
            filteredEmptyAction={<ClearFiltersLink onClick={clearFilters} />}
            mobileChildren={rows.map((supplier) => (
              <ResourceCard
                key={supplier.id}
                href={archived ? undefined : `/purchases/suppliers/${supplier.id}`}
                title={supplier.name}
                meta={
                  <>
                    <ResourceCardMeta label={t("columns.taxId")}>{supplier.taxId ?? "—"}</ResourceCardMeta>
                    <ResourceCardMeta label={t("columns.salesContact")}>
                      {contactLine(supplier.salesContactName, supplier.salesContactEmail, supplier.salesContactPhone) ?? "—"}
                    </ResourceCardMeta>
                  </>
                }
                actions={rowActions(supplier) ?? undefined}
              />
            ))}
          >
            {rows.map((supplier) => {
              const href = `/purchases/suppliers/${supplier.id}`;
              const cells = (
                <>
                  <TableCell className="font-medium">
                    {archived ? (
                      supplier.name
                    ) : (
                      <Link href={href} className="hover:underline">
                        {supplier.name}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">{supplier.taxId ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {contactLine(supplier.salesContactName, supplier.salesContactEmail, supplier.salesContactPhone) ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {contactLine(
                      supplier.supportContactName,
                      supplier.supportContactEmail,
                      supplier.supportContactPhone,
                    ) ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className={cn("flex justify-end", !archived && rowActionsReveal)}>
                      {rowActions(supplier)}
                    </div>
                  </TableCell>
                </>
              );
              return archived ? (
                <TableRow key={supplier.id}>{cells}</TableRow>
              ) : (
                <LinkableRow key={supplier.id} href={href}>
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

      <SupplierFormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        supplier={editing && editing !== "new" ? editing : undefined}
      />
      {deleting ? (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          entityKey="supplier"
          name={deleting.name}
          onConfirm={() => deleteSupplier.mutateAsync(deleting.id)}
        >
          {t("archiveNote")}
        </DeleteConfirmDialog>
      ) : null}
    </div>
  );
}
