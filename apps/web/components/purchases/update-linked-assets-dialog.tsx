"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { PurchaseCostValue } from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useApplyToLinked, useLinkedPreview } from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { initialLinkedSelection, linkedCostRows } from "@/lib/purchases/linked-update";
import { formatMoney } from "@/lib/utils/money";

/**
 * *Update cost on linked assets?* (#1502; ADR-0099 §2, UX proposal §3.a) — the follow-up after a line's unit
 * price was edited while assets are linked to it. Lists each linked asset with its current → new cost; the
 * assets that still hold the old purchase value (or have none) are pre-checked, the ones whose cost was
 * changed by hand are unchecked and marked *overridden* — "follow unless overridden". Nothing changes until
 * the person confirms; cost and currency move together. Needs `purchaseOrder:write` + `asset:write` (the
 * caller gates it). Mounted only while open.
 */
export function UpdateLinkedAssetsDialog({
  purchaseId,
  lineId,
  lineDescription,
  previousUnitPrice,
  onClose,
}: {
  purchaseId: string;
  lineId: string;
  lineDescription: string;
  /** The unit price before the edit (`null` = the line had none). */
  previousUnitPrice: number | null;
  onClose: () => void;
}) {
  const t = useTranslations("purchases.linkedUpdate");
  const tc = useTranslations("common");
  const treasons = useTranslations("purchases.link.reasons");
  const locale = useLocale();
  const preview = useLinkedPreview({ purchaseOrderId: purchaseId, lineId, previousUnitPrice });
  const apply = useApplyToLinked();
  // The choices are seeded once from the preview — a refetch never resets what the person ticked.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  // Seeded from a settled read only, so a cached answer from an earlier edit never picks the boxes.
  if (preview.data && !preview.isFetching && selected === null) setSelected(initialLinkedSelection(preview.data.assets));
  const chosen = selected ?? new Set<string>();

  const rows = preview.data ? linkedCostRows(preview.data.assets) : [];
  const selectable = rows.filter((row) => row.selectable);

  function cost(value: PurchaseCostValue | null): string {
    if (value === null || value.amount === null) return t("noCost");
    return formatMoney(value.amount, locale, value.currency);
  }

  function toggle(id: string, on: boolean) {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  function submit() {
    const assetIds = selectable.filter((row) => chosen.has(row.assetId)).map((row) => row.assetId);
    if (assetIds.length === 0) return;
    apply.mutate(
      { id: purchaseId, lineId, assetIds, fields: ["purchaseCost"] },
      {
        onSuccess: (outcome) => {
          if (outcome.error) {
            // A call failed outright. Earlier calls stay applied (each is its own transaction): say how far it got.
            if (outcome.updated > 0) {
              toast.error(t("partialError", { updated: outcome.updated, notSent: outcome.notSent }));
            } else {
              notifyError(outcome.error, t("error"));
            }
            return;
          }
          if (outcome.failed.length > 0) {
            const first = outcome.failed[0]!;
            const reason =
              first.reason === "NOT_FOUND"
                ? treasons("notFound")
                : first.reason === "NOT_LINKED"
                  ? treasons("notLinked")
                  : first.error;
            toast.warning(t("partialToast", { updated: outcome.updated, failed: outcome.failed.length }), {
              description: reason,
            });
          } else {
            toast.success(t("updatedToast", { count: outcome.updated }));
          }
          onClose();
        },
        onError: (error) => notifyError(error, t("error")),
      },
    );
  }

  const count = selectable.filter((row) => chosen.has(row.assetId)).length;

  return (
    <Dialog open onOpenChange={(open) => !open && !apply.isPending && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { line: lineDescription })}</DialogDescription>
        </DialogHeader>

        {preview.isError ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("previewError")}</p>
            <Button variant="outline" size="sm" onClick={() => preview.refetch()}>
              <ArrowPathIcon />
              {tc("retry")}
            </Button>
          </div>
        ) : !preview.data || selected === null ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        ) : (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            <ul className="divide-y rounded-md border">
              {rows.map((row) => {
                const id = `linked-update-${row.assetId}`;
                return (
                  <li key={row.assetId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <Checkbox
                      id={id}
                      disabled={!row.selectable}
                      checked={row.selectable && chosen.has(row.assetId)}
                      onCheckedChange={(on) => toggle(row.assetId, on === true)}
                      aria-label={t("assetLabel", { asset: row.assetTag ?? row.name })}
                    />
                    <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                      <span className="font-medium">{row.name}</span>
                      {row.assetTag ? (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{row.assetTag}</span>
                      ) : null}
                    </label>
                    <span className="font-mono text-xs tabular-nums">
                      {row.selectable
                        ? t("change", { from: cost(row.current), to: cost(row.next) })
                        : cost(row.current)}
                    </span>
                    {row.overridden ? <StatusBadge tone="neutral">{t("overridden")}</StatusBadge> : null}
                    {!row.selectable ? (
                      <span className="text-xs text-muted-foreground">{t("alreadySame")}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">{t("help")}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={apply.isPending}>
            {t("keep")}
          </Button>
          {selectable.length > 0 ? (
            <Button onClick={submit} disabled={apply.isPending || count === 0}>
              {apply.isPending && <ArrowPathIcon className="animate-spin" />}
              {t("submit", { count })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
