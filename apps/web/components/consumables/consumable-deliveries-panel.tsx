"use client";

import { ArrowPathIcon, ArrowUturnLeftIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { ConsumableDelivery } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { DetailPanel } from "@/components/detail-panel";
import { Pagination } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api/client";
import { useConsumableDeliveries } from "@/lib/api/hooks/use-consumables";
import { useUserNames } from "@/lib/api/hooks/use-users";
import {
  DELIVERY_RANGE_PRESETS,
  type DeliveryRangePreset,
  type DeliveryTargetRef,
  deliveryRangeFrom,
  deliveryTargetQuery,
} from "@/lib/consumables/deliveries";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { DeliverConsumableDialog } from "./deliver-consumable-dialog";
import { ReturnDeliveryDialog } from "./return-delivery-dialog";

/** Rows per page — a secondary panel, so a short page. */
const PAGE_SIZE = 10;

/**
 * The consumables delivered to ONE person, asset or location (ADR-0098) — a secondary section mounted on
 * the user, asset and location detail pages. It lists `GET /consumables/deliveries` for that target,
 * newest first: the consumable (linked; an archived one is flagged), the quantity, when and by whom, and
 * for a returnable delivery what is still outstanding. Light filters (outstanding only, a date preset)
 * and the house offset pagination.
 *
 * Writes are gated on `consumable:write`: **Deliver consumable** (a targeted OUT, when the target is
 * live) and **Return** on an outstanding row (an IN linked to it). The movement mutation invalidates the
 * whole consumables cache (these lists included) and the asset timeline.
 *
 * Visibility: the read needs `consumable:read` AND the target domain's read permission. Without the
 * former the panel never fires; a 403 from the API (e.g. a VIEWER on a person) hides the section —
 * this is a secondary view, not an error worth shouting about.
 */
export function ConsumableDeliveriesPanel({
  target,
  targetName,
  targetLive = true,
}: {
  target: DeliveryTargetRef;
  /** Display name of the person / asset / location, for the deliver dialog copy. */
  targetName: string;
  /** False for an offboarded / deleted target — no new deliveries (the API would refuse them). */
  targetLive?: boolean;
}) {
  const t = useTranslations("consumables.deliveries");
  const tc = useTranslations("common");
  const { date } = useFormatters();
  const canRead = useCan("consumable:read");
  const canWrite = useCan("consumable:write");
  const canReadUsers = useCan("user:read");

  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [range, setRange] = useState<{
    preset: DeliveryRangePreset;
    from: string | undefined;
  }>({ preset: "all", from: undefined });
  const [offset, setOffset] = useState(0);
  const [deliverOpen, setDeliverOpen] = useState(false);
  const [returning, setReturning] = useState<ConsumableDelivery | null>(null);

  const params = useMemo(
    () => ({
      ...deliveryTargetQuery(target),
      outstandingOnly,
      from: range.from,
      limit: PAGE_SIZE,
      offset,
    }),
    [target, outstandingOnly, range.from, offset],
  );
  const { data, isLoading, isError, error, isFetching, refetch } =
    useConsumableDeliveries(params, canRead);

  const items = useMemo(() => data?.items ?? [], [data]);
  const actorIds = useMemo(
    () =>
      items
        .map((delivery) => delivery.performedById)
        .filter((id): id is string => id != null),
    [items],
  );
  const userById = useUserNames(actorIds, { enabled: canReadUsers });

  // No consumable:read → the read would 403; a 403 for the target domain → hide the section too.
  if (!canRead) return null;
  if (error instanceof ApiError && error.status === 403) return null;

  const filtered = outstandingOnly || range.preset !== "all";

  return (
    <DetailPanel
      title={
        data && data.total > 0
          ? t("titleCount", { count: data.total })
          : t("title")
      }
      actions={
        canWrite && targetLive ? (
          <Button size="sm" variant="outline" onClick={() => setDeliverOpen(true)}>
            <PlusIcon />
            {t("deliverAction")}
          </Button>
        ) : undefined
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <Switch
            id={`deliveries-outstanding-${target.id}`}
            checked={outstandingOnly}
            onCheckedChange={(checked) => {
              setOutstandingOnly(checked);
              setOffset(0);
            }}
          />
          <Label
            htmlFor={`deliveries-outstanding-${target.id}`}
            className="font-normal"
          >
            {t("outstandingOnly")}
          </Label>
        </div>
        <Select
          value={range.preset}
          onValueChange={(value) => {
            const preset = value as DeliveryRangePreset;
            // Resolve the lower bound once, at selection, so the query key stays stable.
            setRange({ preset, from: deliveryRangeFrom(preset, new Date()) });
            setOffset(0);
          }}
        >
          <SelectTrigger size="sm" className="w-44" aria-label={t("rangeLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DELIVERY_RANGE_PRESETS.map((preset) => (
              <SelectItem key={preset} value={preset}>
                {t(`range.${preset}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <ul className="divide-y" aria-hidden>
          {[0, 1].map((i) => (
            <li key={i} className="space-y-1.5 py-3 first:pt-0">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </li>
          ))}
        </ul>
      ) : isError ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">{t("loadError")}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <ArrowPathIcon />
            {tc("retry")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {filtered ? t("emptyFiltered") : t("empty")}
        </p>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y">
            {items.map((delivery) => {
              const actor = delivery.performedById
                ? userById.get(delivery.performedById)
                : undefined;
              const archived = delivery.consumable.deletedAt != null;
              const outstanding = delivery.returnable
                ? delivery.outstandingQuantity
                : 0;
              return (
                <li
                  key={delivery.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/consumables/${delivery.consumable.id}`}
                        className="truncate font-medium hover:underline"
                      >
                        {delivery.consumable.name}
                      </Link>
                      {archived ? (
                        <StatusBadge tone="neutral">{t("archived")}</StatusBadge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono tabular-nums">
                        {t("quantity", {
                          count: delivery.quantity,
                          unit: delivery.consumable.unit,
                        })}
                      </span>
                      <span aria-hidden> · </span>
                      <span className="font-mono tabular-nums">
                        {date(delivery.createdAt)}
                      </span>
                      {actor ? (
                        <>
                          <span aria-hidden> · </span>
                          {t("by", {
                            name: `${actor.firstName} ${actor.lastName}`,
                          })}
                        </>
                      ) : null}
                    </p>
                    {delivery.notes ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {delivery.notes}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {delivery.returnable ? (
                      outstanding > 0 ? (
                        <StatusBadge tone="warning">
                          {t("outstanding", {
                            count: outstanding,
                            unit: delivery.consumable.unit,
                          })}
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="success">{t("returned")}</StatusBadge>
                      )
                    ) : null}
                    {canWrite && outstanding > 0 && !archived ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setReturning(delivery)}
                      >
                        <ArrowUturnLeftIcon />
                        {t("returnAction")}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {data ? (
            <Pagination
              total={data.total}
              limit={data.limit}
              offset={data.offset}
              itemCount={items.length}
              onOffsetChange={setOffset}
              isFetching={isFetching}
            />
          ) : null}
        </div>
      )}

      {canWrite ? (
        <>
          <DeliverConsumableDialog
            target={target}
            targetName={targetName}
            open={deliverOpen}
            onOpenChange={setDeliverOpen}
          />
          <ReturnDeliveryDialog
            delivery={returning}
            open={returning != null}
            onOpenChange={(open) => {
              if (!open) setReturning(null);
            }}
          />
        </>
      ) : null}
    </DetailPanel>
  );
}
