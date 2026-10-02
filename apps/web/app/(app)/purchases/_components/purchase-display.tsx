"use client";

import type { MoneyTotal, PurchaseOrderReceipt } from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import { useCallback } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { cn } from "@/lib/utils";
import {
  PURCHASE_STATUS_TONE,
  type PurchaseTitleSource,
  purchaseDisplayStatus,
  purchaseTitle,
  receiptProgress,
  totalLines,
} from "@/lib/purchases/display";

/** `(purchase) => its display name`: the reference, else *Supplier · date*, else *Purchase · date*. */
export function usePurchaseTitle() {
  const t = useTranslations("purchases.title");
  const { date } = useFormatters();
  return useCallback(
    (source: PurchaseTitleSource) => {
      const title = purchaseTitle(source);
      switch (title.kind) {
        case "reference":
          return title.reference;
        case "supplier":
          return t("supplierDate", { supplier: title.supplier, date: date(title.date) });
        case "untitled":
          return t("untitled", { date: date(title.date) });
      }
    },
    [t, date],
  );
}

/** The displayed status as a badge; a status a newer build wrote shows its raw text. */
export function PurchaseStatusBadge({
  status,
  receipt,
}: {
  status: string;
  receipt: Pick<PurchaseOrderReceipt, "state"> | null;
}) {
  const t = useTranslations("purchases.status");
  const display = purchaseDisplayStatus(status, receipt);
  return (
    <StatusBadge tone={PURCHASE_STATUS_TONE[display]}>
      {display === "unknown" ? status : t(display)}
    </StatusBadge>
  );
}

/**
 * "x of y received", then the pending and cancelled counts when there are any. Over-received is a
 * warning badge, never an error (ADR-0099 §4). `null` receipt = nothing countable on the purchase.
 */
export function ReceiptSummary({
  receipt,
  className,
}: {
  receipt: PurchaseOrderReceipt | null;
  className?: string;
}) {
  const t = useTranslations("purchases.receipt");
  if (!receipt) return <span className="text-muted-foreground">—</span>;
  const progress = receiptProgress(receipt);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <span className="font-mono tabular-nums">
        {t("progress", { received: progress.received, ordered: progress.ordered })}
      </span>
      {progress.pending > 0 ? (
        <span className="text-muted-foreground">{t("pending", { count: progress.pending })}</span>
      ) : null}
      {progress.cancelled > 0 ? (
        <span className="text-muted-foreground">{t("cancelled", { count: progress.cancelled })}</span>
      ) : null}
      {progress.over ? <StatusBadge tone="warning">{t("over")}</StatusBadge> : null}
    </span>
  );
}

/** The receipt progress bar of a purchase header: neutral track, success fill, counts written beside it. */
export function ReceiptBar({ receipt }: { receipt: PurchaseOrderReceipt }) {
  const progress = receiptProgress(receipt);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div
        className="h-full rounded-full bg-success"
        style={{ width: `${Math.round(progress.ratio * 100)}%` }}
      />
    </div>
  );
}

/**
 * A purchase's totals, one per currency label — never summed or converted across labels (ADR-0099 §5).
 * "No currency" is its own visible state; lines without a price are counted so the total reads as partial.
 */
export function MoneyTotals({
  totals,
  className,
}: {
  totals: readonly MoneyTotal[];
  className?: string;
}) {
  const t = useTranslations("purchases.totals");
  const locale = useLocale();
  const lines = totalLines(totals, locale);
  if (lines.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("inline-flex flex-col gap-0.5", className)}>
      {lines.map((line) => (
        <span key={line.key} className="whitespace-nowrap">
          {line.text === null ? (
            <span className="text-muted-foreground">{t("tooLarge")}</span>
          ) : (
            <span className="font-mono tabular-nums">{line.text}</span>
          )}
          {line.noCurrency ? (
            <span className="text-muted-foreground"> · {t("noCurrency")}</span>
          ) : null}
          {line.unpricedLines > 0 ? (
            <span className="text-xs text-muted-foreground">
              {" "}
              · {t("unpriced", { count: line.unpricedLines })}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}
