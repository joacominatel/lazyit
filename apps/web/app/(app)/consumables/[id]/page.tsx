"use client";

import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  DocumentDuplicateIcon,
  PencilSquareIcon,
  ScaleIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { ConsumableMovementType, User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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
import { useUsers } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { MovementTypeBadge } from "../_components/movement-type-badge";
import { QuickAdjustButtons } from "../_components/quick-adjust-buttons";
import { STOCK_STATUS_TONE, stockTone } from "../_components/stock-badge";
import { StockMovementDialog } from "../_components/stock-movement-dialog";

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

export default function ConsumableDetailPage() {
  const t = useTranslations("consumables");
  const { date } = useFormatters();
  const tc = useTranslations("common");
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  // Edit/Clone + quick-adjust + stock movements are consumable:write; deletion is consumable:delete.
  const canWrite = useCan("consumable:write");
  const canDelete = useCan("consumable:delete");

  const { data: consumable, isLoading, isError, error, refetch } =
    useConsumable(id);
  const { data: movements } = useConsumableMovements(id);
  const { data: categories } = useConsumableCategories();
  const { data: users } = useUsers();
  const deleteConsumable = useDeleteConsumable();

  const [movementType, setMovementType] =
    useState<ConsumableMovementType | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const userById = useMemo(
    () => new Map<string, User>((users ?? []).map((user) => [user.id, user])),
    [users],
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
        breadcrumb={
          <Breadcrumb
            items={[
              { label: t("list.title"), href: "/consumables" },
              { label: consumable.name },
            ]}
          />
        }
        title={consumable.name}
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
          <span className="text-display font-semibold tabular-nums">
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
          <DetailField label={t("detail.skuLabel")}>
            <span className="font-mono">{consumable.sku ?? "—"}</span>
          </DetailField>
          <DetailField label={t("detail.categoryLabel")}>
            {categoryName ? <Badge variant="outline">{categoryName}</Badge> : "—"}
          </DetailField>
          <DetailField label={t("detail.unitLabel")}>
            {consumable.unit}
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
                      <TableCell className="text-right font-medium tabular-nums">
                        {quantityLabel(movement.type, movement.quantity)}
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
                      <TableCell className="text-right tabular-nums text-muted-foreground">
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
