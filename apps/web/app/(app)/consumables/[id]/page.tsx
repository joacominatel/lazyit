"use client";

import {
  ArrowLeftIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  PencilSquareIcon,
  ScaleIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { ConsumableMovementType, User } from "@lazyit/shared";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserAvatar } from "@/components/user-avatar";
import { useConsumableCategories } from "@/lib/api/hooks/use-consumable-categories";
import { useDeleteConsumable } from "@/lib/api/hooks/use-consumable-mutations";
import {
  useConsumable,
  useConsumableMovements,
} from "@/lib/api/hooks/use-consumables";
import { useUsers } from "@/lib/api/hooks/use-users";
import { formatDate } from "@/lib/utils/format";
import { MovementTypeBadge } from "../_components/movement-type-badge";
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

  const { data: consumable, isLoading, isError } = useConsumable(id);
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
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError || !consumable) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <p className="text-sm font-medium">Consumable not found</p>
        <p className="text-sm text-muted-foreground">It may have been deleted.</p>
        <Button variant="outline" asChild>
          <Link href="/consumables">
            <ArrowLeftIcon />
            Back to Consumables
          </Link>
        </Button>
      </div>
    );
  }

  const tone = stockTone(consumable.currentStock, consumable.minStock);
  const categoryName = consumable.categoryId
    ? categories?.find((category) => category.id === consumable.categoryId)?.name
    : undefined;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href="/consumables">
              <ArrowLeftIcon />
              Consumables
            </Link>
          </Button>
          <h1 className="text-3xl font-semibold tracking-tight">
            {consumable.name}
          </h1>
          {consumable.sku && (
            <p className="font-mono text-sm text-muted-foreground">
              {consumable.sku}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </div>

      <Panel
        title="Stock"
        action={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setMovementType("IN")}>
              <ArrowDownTrayIcon />
              Add
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMovementType("OUT")}>
              <ArrowUpTrayIcon />
              Remove
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMovementType("ADJUSTMENT")}
            >
              <ScaleIcon />
              Adjust
            </Button>
          </div>
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
      </Panel>

      <Panel title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <Detail label="SKU">
            <span className="font-mono">{consumable.sku ?? "—"}</span>
          </Detail>
          <Detail label="Category">
            {categoryName ? <Badge variant="outline">{categoryName}</Badge> : "—"}
          </Detail>
          <Detail label="Unit">{consumable.unit}</Detail>
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
      </Panel>

      <Panel title="Movements">
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
                          <span className="flex items-center gap-2">
                            <UserAvatar
                              size="sm"
                              firstName={actor.firstName}
                              lastName={actor.lastName}
                              email={actor.email}
                            />
                            <span className="truncate">
                              {actor.firstName} {actor.lastName}
                            </span>
                          </span>
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
      </Panel>

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

/** A bordered section with a heading and optional header action. */
function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A label/value pair in the details grid. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
