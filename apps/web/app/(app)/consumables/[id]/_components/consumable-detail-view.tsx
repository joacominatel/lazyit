"use client";

import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  DocumentDuplicateIcon,
  PencilSquareIcon,
  ScaleIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type {
  ConsumableMovement,
  ConsumableMovementType,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailField, DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/resource-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserAvatar } from "@/components/user-avatar";
import { useCan } from "@/lib/hooks/use-permissions";
import { useConsumableCategories } from "@/lib/api/hooks/use-consumable-categories";
import { useDeleteConsumable } from "@/lib/api/hooks/use-consumable-mutations";
import {
  useConsumable,
  useConsumableMovements,
} from "@/lib/api/hooks/use-consumables";
import { useUserNames } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import {
  deliveryReturnState,
  returnedByDelivery,
} from "@/lib/consumables/deliveries";
import { DeliveryTargetLabel } from "../../_components/delivery-target-label";
import { MovementTypeBadge } from "../../_components/movement-type-badge";
import { QuickAdjustButtons } from "../../_components/quick-adjust-buttons";
import { STOCK_STATUS_TONE, stockTone } from "../../_components/stock-badge";
import { StockMovementDialog } from "../../_components/stock-movement-dialog";

/** Stock tone → its i18n key under `consumables.detail` for the display label. */
const STATUS_LABEL_KEY = {
  ok: "statusInStock",
  low: "statusLowStock",
  out: "statusOutOfStock",
} as const;

/** Signed quantity prefix per movement type (IN adds, OUT subtracts, ADJUSTMENT sets absolute). */
function quantityLabel(type: ConsumableMovementType, quantity: number): string {
  if (type === "IN") return `+${quantity}`;
  if (type === "OUT") return `−${quantity}`;
  return `=${quantity}`;
}

/**
 * The ledger's destination cell (ADR-0098). A delivery (a targeted OUT) names where it went and, when
 * returnable, how much is back / still out; a return (an IN with `returnOfId`) names the delivery it gives
 * back — by its ledger number, plus the recipient when that delivery is on the page. Anything else is "—".
 */
function MovementDestination({
  movement,
  returnState,
  returnOf,
}: {
  movement: ConsumableMovement;
  returnState: { returned: number; outstanding: number } | null;
  returnOf: ConsumableMovement | undefined;
}) {
  const t = useTranslations("consumables.detail");
  if (movement.returnOfId != null) {
    return (
      <div className="space-y-0.5 text-sm">
        <p className="text-muted-foreground">
          {t("returnOf", { id: movement.returnOfId })}
        </p>
        {returnOf?.target ? (
          <p className="text-xs">
            <DeliveryTargetLabel target={returnOf.target} />
          </p>
        ) : null}
      </div>
    );
  }
  if (!movement.target) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="space-y-0.5 text-sm">
      <DeliveryTargetLabel target={movement.target} />
      {returnState ? (
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {returnState.outstanding > 0
            ? t("deliveryOutstanding", {
                id: movement.id,
                outstanding: returnState.outstanding,
                returned: returnState.returned,
              })
            : t("deliveryReturned", { id: movement.id })}
        </p>
      ) : null}
    </div>
  );
}

export function ConsumableDetailView({ id }: { id: string }) {
  const t = useTranslations("consumables");
  const { date } = useFormatters();
  const tc = useTranslations("common");
  const router = useRouter();
  // Edit/Clone + quick-adjust + stock movements are consumable:write; deletion is consumable:delete.
  const canWrite = useCan("consumable:write");
  const canDelete = useCan("consumable:delete");

  const { data: consumable, isLoading, isError, error, refetch } =
    useConsumable(id);
  const { data: movements } = useConsumableMovements(id);
  const { data: categories } = useConsumableCategories();
  const deleteConsumable = useDeleteConsumable();

  const [movementType, setMovementType] =
    useState<ConsumableMovementType | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Resolve just the actors of this consumable's movements (#961) — a targeted id→name batch, not
  // the whole directory.
  const actorIds = useMemo(
    () =>
      (movements ?? [])
        .map((movement) => movement.performedById)
        .filter((mid): mid is string => mid != null),
    [movements],
  );
  const userById = useUserNames(actorIds);
  // Units returned per delivery (ADR-0098), summed over the full (unfiltered) ledger, so each returnable
  // delivery row can say how much is still out; and the ledger by id, so a return row can name the
  // delivery it gives back.
  const returned = useMemo(
    () => returnedByDelivery(movements ?? []),
    [movements],
  );
  const movementById = useMemo(
    () => new Map((movements ?? []).map((movement) => [movement.id, movement])),
    [movements],
  );

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: t("list.title"), href: "/consumables" },
          { label: consumable?.name ?? "" },
        ]}
      />
    ),
    [t, consumable?.name],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <DetailSkeleton panels={3} />
      </div>
    );
  }

  if (isError || !consumable) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const tone = stockTone(consumable.currentStock, consumable.minStock);
  const categoryName = consumable.categoryId
    ? categories?.find((category) => category.id === consumable.categoryId)?.name
    : undefined;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={breadcrumb}
        title={consumable.name}
        badge={
          // A quiet marker (ADR-0098): deliveries of this item are expected back.
          consumable.returnable ? (
            <Badge variant="outline">{t("detail.returnableBadge")}</Badge>
          ) : undefined
        }
        subtitle={
          consumable.sku ? (
            <span className="font-mono">{consumable.sku}</span>
          ) : undefined
        }
        actions={
          canWrite || canDelete ? (
            <>
              {canWrite ? (
                <>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/consumables/${consumable.id}/edit`}>
                      <PencilSquareIcon />
                      {tc("edit")}
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/consumables/${consumable.id}/clone`}>
                      <DocumentDuplicateIcon />
                      {t("detail.cloneAction")}
                    </Link>
                  </Button>
                </>
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("detail.deleteAction")}
                  onClick={() => setDeleteOpen(true)}
                >
                  <TrashIcon />
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      <DetailPanel
        title={t("detail.stockSection")}
        actions={
          canWrite ? (
            <QuickAdjustButtons
              consumableId={consumable.id}
              name={consumable.name}
              currentStock={consumable.currentStock}
              unit={consumable.unit}
              size="sm"
            />
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-display font-mono font-semibold tabular-nums">
            {consumable.currentStock}
          </span>
          <span className="text-lg text-muted-foreground">{consumable.unit}</span>
          <StatusBadge tone={STOCK_STATUS_TONE[tone]}>
            {t(`detail.${STATUS_LABEL_KEY[tone]}`)}
          </StatusBadge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {consumable.minStock != null
            ? t("detail.reorderThreshold", {
                value: consumable.minStock,
                unit: consumable.unit,
              })
            : t("detail.noReorderThreshold")}
        </p>
        {/* Quick adjust (±1) above covers the common case; these open the detailed form
            for a specific quantity / reason, or an absolute recount. */}
        {canWrite && (
          <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMovementType("IN")}
            >
              <ArrowDownTrayIcon />
              {t("stock.addCta")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMovementType("OUT")}
            >
              <ArrowUpTrayIcon />
              {t("stock.removeCta")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMovementType("ADJUSTMENT")}
            >
              <ScaleIcon />
              {t("stock.adjustCta")}
            </Button>
          </div>
        )}
      </DetailPanel>

      <DetailPanel title={t("detail.detailsSection")}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailField label={t("detail.skuLabel")} mono>
            {consumable.sku ?? "—"}
          </DetailField>
          <DetailField label={t("detail.categoryLabel")}>
            {categoryName ? <Badge variant="outline">{categoryName}</Badge> : "—"}
          </DetailField>
          <DetailField label={t("detail.unitLabel")}>
            {consumable.unit}
          </DetailField>
          <DetailField label={t("detail.returnableLabel")}>
            {consumable.returnable
              ? t("detail.returnableYes")
              : t("detail.returnableNo")}
          </DetailField>
        </dl>
        {consumable.description && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">
              {t("detail.descriptionLabel")}
            </dt>
            <dd className="text-sm whitespace-pre-wrap">
              {consumable.description}
            </dd>
          </div>
        )}
        {consumable.notes && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">
              {t("detail.notesLabel")}
            </dt>
            <dd className="text-sm whitespace-pre-wrap">{consumable.notes}</dd>
          </div>
        )}
      </DetailPanel>

      <DetailPanel title={t("detail.movementsSection")}>
        {(movements?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("detail.movementsEmpty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">
                    {t("detail.movementColumns.type")}
                  </TableHead>
                  <TableHead className="w-20 text-right">
                    {t("detail.movementColumns.qty")}
                  </TableHead>
                  <TableHead>{t("detail.movementColumns.destination")}</TableHead>
                  <TableHead>{t("detail.movementColumns.reason")}</TableHead>
                  <TableHead>{t("detail.movementColumns.by")}</TableHead>
                  <TableHead className="text-right">
                    {t("detail.movementColumns.date")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(movements ?? []).map((movement) => {
                  const actor = movement.performedById
                    ? userById.get(movement.performedById)
                    : undefined;
                  return (
                    <TableRow key={movement.id}>
                      <TableCell>
                        <MovementTypeBadge type={movement.type} />
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium tabular-nums">
                        {quantityLabel(movement.type, movement.quantity)}
                      </TableCell>
                      <TableCell>
                        <MovementDestination
                          movement={movement}
                          returnState={deliveryReturnState(movement, returned)}
                          returnOf={
                            movement.returnOfId != null
                              ? movementById.get(movement.returnOfId)
                              : undefined
                          }
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {movement.reason ?? "—"}
                      </TableCell>
                      <TableCell>
                        {actor ? (
                          <Link
                            href={`/users/${actor.id}`}
                            className="flex items-center gap-2 hover:underline"
                          >
                            <UserAvatar
                              size="sm"
                              firstName={actor.firstName}
                              lastName={actor.lastName}
                              email={actor.email}
                            />
                            <span className="truncate">
                              {actor.firstName} {actor.lastName}
                            </span>
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            {t("detail.system")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                        {date(movement.createdAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </DetailPanel>

      <StockMovementDialog
        open={movementType != null}
        onOpenChange={(open) => {
          if (!open) setMovementType(null);
        }}
        consumableId={consumable.id}
        type={movementType ?? "IN"}
        currentStock={consumable.currentStock}
        unit={consumable.unit}
        returnable={consumable.returnable ?? false}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityKey="consumable"
        name={consumable.name}
        onConfirm={() => deleteConsumable.mutateAsync(consumable.id)}
        onDeleted={() => router.push("/consumables")}
      />
    </div>
  );
}
