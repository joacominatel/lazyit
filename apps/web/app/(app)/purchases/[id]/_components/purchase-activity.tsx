"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { PurchaseOrderLine } from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/user-avatar";
import { usePurchaseOrderEvents } from "@/lib/api/hooks/use-purchase-orders";
import { useUserNames } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import {
  DATE_FIELDS,
  describePurchaseEvent,
  type FieldChange,
  ID_FIELDS,
  MONEY_FIELDS,
} from "@/lib/purchases/events";
import { formatMoney } from "@/lib/utils/money";

/** Field name → its label key under `purchases.activity.fields`. Unknown names print as logged. */
const FIELD_LABELS = new Set([
  "supplierId",
  "reference",
  "currency",
  "orderDate",
  "expectedDate",
  "deliveryLocationId",
  "company",
  "invoiceNumbers",
  "invoiceDate",
  "notes",
  "kind",
  "description",
  "manufacturerText",
  "modelText",
  "assetModelId",
  "consumableId",
  "quantity",
  "unitPrice",
  "cancelledQuantity",
  "warrantyMonths",
  "position",
]);

/** Stored status → its label key under `purchases.status`. */
const STATUS_KEY: Record<string, string> = {
  DRAFT: "draft",
  ORDERED: "ordered",
  CANCELLED: "cancelled",
};

/**
 * The purchase's append-only activity log (ADR-0099, purchase-order-event entity note), newest first:
 * who did what and when, with a price or quantity change shown before → after; units received, linked,
 * moved and cancelled; documents added and removed (#1475). Read tolerantly — an event type a later build
 * adds shows generically until this screen learns it.
 */
export function PurchaseActivity({
  purchaseId,
  lines,
}: {
  purchaseId: string;
  /** The live lines, to name the line an event refers to. */
  lines: readonly PurchaseOrderLine[];
}) {
  const t = useTranslations("purchases.activity");
  const tStatus = useTranslations("purchases.status");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { date, dateTime, relative } = useFormatters();
  const canReadUsers = useCan("user:read");
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    usePurchaseOrderEvents(purchaseId);
  const events = useMemo(() => (data?.pages ?? []).flatMap((page) => page.items), [data]);
  const actorIds = useMemo(
    () => events.flatMap((event) => (event.performedById ? [event.performedById] : [])),
    [events],
  );
  const userById = useUserNames(actorIds, { enabled: canReadUsers });
  const lineById = useMemo(() => new Map(lines.map((line) => [line.id, line])), [lines]);

  const statusLabel = (value: string | null) =>
    value === null ? "—" : STATUS_KEY[value] ? tStatus(STATUS_KEY[value]) : value;
  const fieldLabel = (field: string) => (FIELD_LABELS.has(field) ? t(`fields.${field}`) : field);

  /** `currency` is the label the event recorded (`null` → the amount prints without one). */
  function valueText(change: FieldChange, side: unknown, currency: string | null): string {
    if (side === null || side === undefined || side === "") return t("blank");
    if (MONEY_FIELDS.has(change.field) && typeof side === "number") {
      return formatMoney(side, locale, currency);
    }
    if (DATE_FIELDS.has(change.field) && typeof side === "string") return date(side);
    if (change.field === "kind" && typeof side === "string") {
      if (side === "ASSET") return t("kindAsset");
      if (side === "CONSUMABLE") return t("kindConsumable");
      return side === "OTHER" ? t("kindOther") : side;
    }
    return String(side);
  }

  function changesText(changes: FieldChange[], currency: string | null): string {
    return changes
      .map((change) =>
        change.nameOnly || ID_FIELDS.has(change.field)
          ? fieldLabel(change.field)
          : t("change", {
              field: fieldLabel(change.field),
              from: valueText(change, change.from, currency),
              to: valueText(change, change.to, currency),
            }),
      )
      .join(" · ");
  }

  function lineName(lineId: string | null, fallback: string | null): string {
    return lineById.get(lineId ?? "")?.description ?? fallback ?? t("aLine");
  }

  function headline(event: (typeof events)[number]): ReactNode {
    const view = describePurchaseEvent(event);
    switch (view.kind) {
      case "created":
        return view.lineCount ? t("createdWithLines", { count: view.lineCount }) : t("created");
      case "statusChanged":
        return t("statusChanged", { from: statusLabel(view.from), to: statusLabel(view.to) });
      case "updated":
        return view.changes.length > 0 ? t("updated", { changes: changesText(view.changes, view.currency) }) : t("updatedGeneric");
      case "lineAdded":
        return t("lineAdded", {
          line: view.description ?? t("aLine"),
          quantity: view.quantity ?? 1,
          price:
            view.unitPrice === null ? t("noPrice") : formatMoney(view.unitPrice, locale, view.currency),
        });
      case "lineUpdated":
        return t("lineUpdated", {
          line: lineName(view.lineId, null),
          changes: view.changes.length > 0 ? changesText(view.changes, view.currency) : t("blank"),
        });
      case "lineRemoved":
        return t("lineRemoved", { line: lineName(view.lineId, view.description) });
      case "unitsReceived":
        return [
          t("unitsReceived", { count: view.quantity ?? 0, line: lineName(view.lineId, null) }),
          view.failed > 0 ? t("unitsFailed", { count: view.failed }) : null,
          view.over ? t("overReceived") : null,
        ]
          .filter(Boolean)
          .join(" · ");
      case "unitsCancelled":
        return [
          t("unitsCancelled", { count: view.quantity ?? 0, line: lineName(view.lineId, null) }),
          view.reason ? t("reason", { reason: view.reason }) : null,
        ]
          .filter(Boolean)
          .join(" · ");
      case "assetsLinked":
        return [
          t(view.moved ? "assetsMoved" : "assetsLinked", { count: view.count ?? 0, line: lineName(view.lineId, null) }),
          view.over ? t("overReceived") : null,
        ]
          .filter(Boolean)
          .join(" · ");
      case "assetsUnlinked":
        return t(view.movedToPurchaseOrderId ? "assetsMovedAway" : "assetsUnlinked", {
          count: view.count ?? 0,
          line: lineName(view.lineId, null),
        });
      case "documentAdded":
        return t("documentAdded", { name: view.name ?? t("aDocument") });
      case "documentRemoved":
        return t("documentRemoved", { name: view.name ?? t("aDocument") });
      case "deleted":
        return t("deleted");
      case "restored":
        return t("restored");
      case "other":
        return t("other", { type: view.eventType });
    }
  }

  if (isLoading) {
    return (
      <ul className="space-y-4">
        {["a", "b", "c"].map((key) => (
          <li key={key} className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </li>
        ))}
      </ul>
    );
  }
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">{t("loadError")}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <ArrowPathIcon />
          {tc("retry")}
        </Button>
      </div>
    );
  }
  if (events.length === 0) return <p className="text-sm text-muted-foreground">{t("none")}</p>;

  return (
    <div className="space-y-4">
      <ol className="space-y-4">
        {events.map((event) => {
          const actor = event.performedById ? userById.get(event.performedById) : undefined;
          return (
            <li key={event.id} className="space-y-1 border-l-2 pl-3">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm">{headline(event)}</span>
                <span
                  className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                  title={dateTime(event.createdAt)}
                >
                  {relative(event.createdAt)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {actor ? (
                  <>
                    <UserAvatar
                      size="sm"
                      firstName={actor.firstName}
                      lastName={actor.lastName}
                      email={actor.email}
                    />
                    <span>
                      {actor.firstName} {actor.lastName}
                    </span>
                  </>
                ) : (
                  <span>
                    {event.serviceAccountId
                      ? t("serviceAccount")
                      : event.performedById
                        ? t("aUser")
                        : t("system")}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {hasNextPage ? (
        <Button variant="outline" size="sm" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage && <ArrowPathIcon className="animate-spin" />}
          {t("loadMore")}
        </Button>
      ) : null}
    </div>
  );
}
