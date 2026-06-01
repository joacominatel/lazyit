"use client";

import {
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  PencilSquareIcon,
  ScaleIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { ConsumableMovementType, User } from "@lazyit/shared";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailField, DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/breadcrumb";
import { Badge } from "@/components/ui/badge";
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
import { useCanWrite } from "@/lib/hooks/use-permissions";
import { useConsumableCategories } from "@/lib/api/hooks/use-consumable-categories";
import { useDeleteConsumable } from "@/lib/api/hooks/use-consumable-mutations";
import {
  useConsumable,
  useConsumableMovements,
} from "@/lib/api/hooks/use-consumables";
import { useUsers } from "@/lib/api/hooks/use-users";
import { formatDate } from "@/lib/utils/format";
import { MovementTypeBadge } from "../_components/movement-type-badge";
import { QuickAdjustButtons } from "../_components/quick-adjust-buttons";
import { stockTone } from "../_components/stock-badge";
import { StockMovementDialog } from "../_components/stock-movement-dialog";

const STATUS_LABEL = {
  ok: "In stock",
  low: "Low stock",
  out: "Out of stock",
} as const;

const STATUS_CLASS = {
  ok: "text-emerald-600 dark:text-emerald-400",
  low: "text-amber-600 dark:text-amber-400",
  out: "text-destructive",
} as const;

/** Signed quantity prefix per movement type (IN adds, OUT subtracts, ADJUSTMENT sets absolute). */
function quantityLabel(type: ConsumableMovementType, quantity: number): string {
  if (type === "IN") return `+${quantity}`;
  if (type === "OUT") return `−${quantity}`;
  return `=${quantity}`;
}

export default function ConsumableDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const canWrite = useCanWrite();

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
          title="Consumable not found"
          description="It may have been deleted, or the API is unreachable."
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
              { label: "Consumables", href: "/consumables" },
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
          canWrite ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/consumables/${consumable.id}/edit`}>
                  <PencilSquareIcon />
                  Edit
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete consumable"
                onClick={() => setDeleteOpen(true)}
              >
                <TrashIcon />
              </Button>
            </>
          ) : undefined
        }
      />

      <DetailPanel
        title="Stock"
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
          <span className="text-4xl font-semibold tabular-nums">
            {consumable.currentStock}
          </span>
          <span className="text-lg text-muted-foreground">{consumable.unit}</span>
          <span className={`text-sm font-medium ${STATUS_CLASS[tone]}`}>
            · {STATUS_LABEL[tone]}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {consumable.minStock != null
            ? `Reorder threshold: ${consumable.minStock} ${consumable.unit}`
            : "No reorder threshold set."}
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
              Add…
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMovementType("OUT")}
            >
              <ArrowUpTrayIcon />
              Remove…
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMovementType("ADJUSTMENT")}
            >
              <ScaleIcon />
              Adjust…
            </Button>
          </div>
        )}
      </DetailPanel>

      <DetailPanel title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailField label="SKU">
            <span className="font-mono">{consumable.sku ?? "—"}</span>
          </DetailField>
          <DetailField label="Category">
            {categoryName ? <Badge variant="outline">{categoryName}</Badge> : "—"}
          </DetailField>
          <DetailField label="Unit">{consumable.unit}</DetailField>
        </dl>
        {consumable.description && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">
              Description
            </dt>
            <dd className="text-sm whitespace-pre-wrap">
              {consumable.description}
            </dd>
          </div>
        )}
        {consumable.notes && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
            <dd className="text-sm whitespace-pre-wrap">{consumable.notes}</dd>
          </div>
        )}
      </DetailPanel>

      <DetailPanel title="Movements">
        {(movements?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No movements yet. Add, remove or adjust stock to start the ledger.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Type</TableHead>
                  <TableHead className="w-20 text-right">Qty</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="text-right">Date</TableHead>
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
                          <span className="text-muted-foreground">System</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatDate(movement.createdAt)}
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
        entityLabel="consumable"
        name={consumable.name}
        onConfirm={() => deleteConsumable.mutateAsync(consumable.id)}
        onDeleted={() => router.push("/consumables")}
      />
    </div>
  );
}
