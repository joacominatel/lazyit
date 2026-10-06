"use client";

import {
  EllipsisVerticalIcon,
  InboxArrowDownIcon,
  KeyIcon,
  ShoppingCartIcon,
} from "@heroicons/react/24/outline";
import type { PendingPurchaseLine } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { ActiveFilters } from "@/components/active-filters";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ApplyLicenseDialog, useCanApplyLicense } from "@/components/purchases/apply-license-dialog";
import { CancelRemainingDialog } from "@/components/purchases/cancel-remaining-dialog";
import { LinkAssetsDialog } from "@/components/purchases/link-assets-dialog";
import { type ReceiveLineTarget, useLoadLineTarget } from "@/components/purchases/pending-line-picker";
import { ErrorState, Pagination } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { usePendingLines } from "@/lib/api/hooks/use-purchase-orders";
import { useSupplier } from "@/lib/api/hooks/use-suppliers";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useCan } from "@/lib/hooks/use-permissions";
import {
  groupPendingLines,
  isOverdue,
  lineReceiveAction,
  localToday,
  pendingTotals,
} from "@/lib/purchases/pending";
import { ReceiveIntoStockDialog, useCanReceiveStock } from "@/components/purchases/receive-into-stock-dialog";
import { ReceiveStockDialog } from "../../../assets/_components/receive-stock-dialog";
import { usePurchaseTitle } from "../../_components/purchase-display";
import { PurchasesTabs } from "../../_components/purchases-tabs";
import { SupplierCombobox } from "../../_components/supplier-combobox";

const PENDING_LIST_OPTIONS = { filters: { supplier: "ALL" } };

/**
 * *Pending units* (ADR-0099, UX proposal §3.f): the lines still waiting for units, grouped by purchase,
 * oldest order first — the weekly view, and the one to open at the warehouse door. Drafts, cancelled
 * purchases, *Other* lines and fully cancelled remainders are not here (the API leaves them out). Each line
 * offers *Receive* and, in its menu, *Link existing* and *Cancel remaining* (a consumable line receives into
 * stock and has no *Link existing*, #1476; a license line offers *Apply license* instead, #1477); a purchase
 * whose expected date has passed is flagged *Overdue* (with text, never colour alone).
 */
export function PendingUnitsView() {
  const t = useTranslations("purchases.pending");
  const tList = useTranslations("purchases.list");
  const tr = useTranslations("purchases.receipt");
  const { date } = useFormatters();
  const titleOf = usePurchaseTitle();
  const canWrite = useCan("purchaseOrder:write");
  const canWriteAssets = useCan("asset:write");
  const canReceive = canWrite && canWriteAssets;
  const canReceiveStock = useCanReceiveStock();
  const canApplyLicense = useCanApplyLicense();
  const { offset, limit, filters, setFilter, setOffset, clearFilters } = useListParams(PENDING_LIST_OPTIONS);
  const supplierId = filters.supplier !== "ALL" ? filters.supplier : undefined;
  const { data: page, isLoading, isFetching, isError, error, refetch } = usePendingLines({
    supplierId,
    limit,
    offset,
  });
  const { data: supplier } = useSupplier(supplierId);
  const loader = useLoadLineTarget();
  const [receiving, setReceiving] = useState<ReceiveLineTarget | null>(null);
  const [receivingStock, setReceivingStock] = useState<PendingPurchaseLine | null>(null);
  const [applyingLicense, setApplyingLicense] = useState<PendingPurchaseLine | null>(null);
  const [linking, setLinking] = useState<PendingPurchaseLine | null>(null);
  const [cancelling, setCancelling] = useState<PendingPurchaseLine | null>(null);

  const groups = groupPendingLines(page?.items ?? []);
  const totals = pendingTotals(groups);
  const today = localToday();

  async function receive(line: PendingPurchaseLine) {
    const target = await loader.load(line);
    if (target) setReceiving(target);
  }

  const chips = supplierId
    ? [
        {
          key: "supplier",
          label: tList("chips.supplier", { name: supplier?.name ?? "—" }),
          onClear: () => setFilter("supplier", "ALL"),
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={tList("title")}
        pillar="inventory"
        icon={ShoppingCartIcon}
        subtitle={t("subtitle")}
      />
      <PurchasesTabs active="pending" />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SupplierCombobox
          value={supplierId ?? ""}
          onValueChange={(value) => setFilter("supplier", value || "ALL")}
          placeholder={tList("allSuppliers")}
          className="lg:w-60"
        />
      </div>
      <ActiveFilters chips={chips} onClearAll={clearFilters} />

      {isLoading ? (
        <div className="space-y-3" aria-hidden>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : isError ? (
        <ErrorState title={t("loadError")} onRetry={() => refetch()} error={error} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={InboxArrowDownIcon}
          pillar="inventory"
          title={supplierId ? t("emptyFiltered") : t("emptyTitle")}
          description={t("emptyDescription")}
        />
      ) : (
        <>
          <ul className="space-y-4">
            {groups.map((group) => {
              const overdue = isOverdue(group.purchase.expectedDate, today);
              const ordered = group.purchase.orderDate ?? group.purchase.createdAt;
              return (
                <li key={group.purchase.id} className="rounded-xl bg-card ring-1 ring-foreground/10">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3 text-sm">
                    <Link href={`/purchases/${group.purchase.id}`} className="font-medium hover:underline">
                      {titleOf(group.purchase)}
                    </Link>
                    {group.purchase.supplier && group.purchase.reference ? (
                      <span className="text-muted-foreground">{group.purchase.supplier.name}</span>
                    ) : null}
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {t("orderedOn", { date: date(ordered) })}
                    </span>
                    {group.purchase.expectedDate ? (
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">
                        {t("expectedOn", { date: date(group.purchase.expectedDate) })}
                      </span>
                    ) : null}
                    {overdue ? <StatusBadge tone="warning">{t("overdue")}</StatusBadge> : null}
                    <span className="ml-auto text-muted-foreground">
                      {tr("pending", { count: group.pending })}
                    </span>
                  </div>
                  <ul className="divide-y">
                    {group.lines.map((line) => (
                      <li key={line.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{line.description}</p>
                          <p className="text-sm text-muted-foreground">
                            <span className="font-mono tabular-nums">
                              {tr("progress", { received: line.receivedQuantity, ordered: line.quantity })}
                            </span>
                            {" · "}
                            {tr("pending", { count: line.pendingQuantity })}
                            {line.cancelledQuantity > 0 ? (
                              <>
                                {" · "}
                                {tr("cancelled", { count: line.cancelledQuantity })}
                              </>
                            ) : null}
                          </p>
                        </div>
                        <PendingLineActions
                          line={line}
                          onReceiveAssets={canReceive ? () => void receive(line) : undefined}
                          receiveDisabled={loader.loading}
                          onReceiveStock={canReceiveStock ? () => setReceivingStock(line) : undefined}
                          onApplyLicense={canApplyLicense ? () => setApplyingLicense(line) : undefined}
                          onLink={canReceive ? () => setLinking(line) : undefined}
                          onCancel={canWrite ? () => setCancelling(line) : undefined}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-muted-foreground" role="status">
            {t("totals", totals)}
          </p>
          <Pagination
            total={page?.total ?? 0}
            limit={page?.limit ?? limit}
            offset={page?.offset ?? offset}
            itemCount={page?.items.length ?? 0}
            onOffsetChange={setOffset}
            isFetching={isFetching}
          />
        </>
      )}

      {receiving ? <ReceiveStockDialog line={receiving} onClose={() => setReceiving(null)} /> : null}
      {receivingStock ? (
        <ReceiveIntoStockDialog
          purchase={receivingStock.purchaseOrder}
          line={receivingStock}
          onClose={() => setReceivingStock(null)}
        />
      ) : null}
      {applyingLicense ? (
        <ApplyLicenseDialog
          purchase={applyingLicense.purchaseOrder}
          line={applyingLicense}
          onClose={() => setApplyingLicense(null)}
        />
      ) : null}
      {linking ? (
        <LinkAssetsDialog
          line={{ purchase: linking.purchaseOrder, line: linking }}
          onClose={() => setLinking(null)}
        />
      ) : null}
      {cancelling ? (
        <CancelRemainingDialog
          purchaseId={cancelling.purchaseOrderId}
          line={cancelling}
          onClose={() => setCancelling(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * A pending line's actions, by what *Receive* means for its kind ({@link lineReceiveAction}): assets are
 * received or linked, a consumable line is received into stock, a license line is applied to its
 * application (#1477) — never an asset receive. Each handler is passed only when the viewer may use it;
 * with none of them, a writer can still cancel the remaining units.
 */
function PendingLineActions({
  line,
  onReceiveAssets,
  receiveDisabled,
  onReceiveStock,
  onApplyLicense,
  onLink,
  onCancel,
}: {
  line: PendingPurchaseLine;
  onReceiveAssets?: () => void;
  receiveDisabled: boolean;
  onReceiveStock?: () => void;
  onApplyLicense?: () => void;
  onLink?: () => void;
  onCancel?: () => void;
}) {
  const t = useTranslations("purchases.pending");
  const action = lineReceiveAction(line.kind);
  const primary =
    action === "receiveAssets" && onReceiveAssets
      ? { label: t("receive"), icon: <InboxArrowDownIcon />, onClick: onReceiveAssets, disabled: receiveDisabled }
      : action === "receiveStock" && onReceiveStock
        ? { label: t("receive"), icon: <InboxArrowDownIcon />, onClick: onReceiveStock, disabled: false }
        : action === "applyLicense" && onApplyLicense
          ? { label: t("applyLicense"), icon: <KeyIcon />, onClick: onApplyLicense, disabled: false }
          : null;

  if (!primary) {
    return onCancel ? (
      <Button variant="ghost" size="sm" onClick={onCancel}>
        {t("cancelRemaining")}
      </Button>
    ) : null;
  }
  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="sm" disabled={primary.disabled} onClick={primary.onClick}>
        {primary.icon}
        {primary.label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t("lineActions", { line: line.description })}>
            <EllipsisVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {action === "receiveAssets" && onLink ? (
            <DropdownMenuItem onSelect={onLink}>{t("linkExisting")}</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onCancel}>{t("cancelRemaining")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
