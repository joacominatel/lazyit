"use client";

import type { PendingPurchaseLine, PurchaseOrderDetail, PurchaseOrderLine } from "@lazyit/shared";
import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { Combobox } from "@/components/combobox";
import { getPurchaseOrder } from "@/lib/api/endpoints/purchase-orders";
import { purchaseOrderKeys, usePendingLines } from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { assetReceivableLines, pendingLinesForModel } from "@/lib/purchases/pending";
import { usePurchaseTitle } from "@/app/(app)/purchases/_components/purchase-display";

/** Receiving against a purchase line: the purchase (for its header values) and the line. */
export interface ReceiveLineTarget {
  purchase: PurchaseOrderDetail;
  line: PurchaseOrderLine;
}

/**
 * Turn an open line into a receive target. The pending row carries only part of the purchase header, so
 * the purchase is read (from the cache when the page already has it) before the dialog is prefilled.
 */
export function useLoadLineTarget() {
  const t = useTranslations("purchases.fromPurchase");
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    async (pending: Pick<PendingPurchaseLine, "id" | "purchaseOrderId">): Promise<ReceiveLineTarget | null> => {
      setLoading(true);
      try {
        const purchase = await queryClient.fetchQuery({
          queryKey: purchaseOrderKeys.detail(pending.purchaseOrderId),
          queryFn: () => getPurchaseOrder(pending.purchaseOrderId),
        });
        const line = purchase.lines.find((candidate) => candidate.id === pending.id);
        return line ? { purchase, line } : null;
      } catch (error) {
        notifyError(error, t("loadError"));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [queryClient, t],
  );
  return { load, loading };
}

/**
 * Whether the viewer may receive units against a purchase line: reading the open lines needs
 * `purchaseOrder:read`, receiving against one `purchaseOrder:write` (the caller already gates `asset:write`).
 */
export function useCanReceiveAgainstPurchases(): boolean {
  const canRead = useCan("purchaseOrder:read");
  const canWrite = useCan("purchaseOrder:write");
  return canRead && canWrite;
}

/**
 * The open purchase lines, read once per surface that offers "From purchase" — one request of at most a
 * page, made only for a viewer who may use it (otherwise no request at all).
 */
export function useOpenLines(enabled: boolean) {
  return usePendingLines({ limit: MAX_PAGE_LIMIT }, { enabled });
}

/** "OC 4512 · Compumundo — Lenovo E14 (3 pending)": how an open line reads in a picker. */
export function usePendingLineLabel() {
  const t = useTranslations("purchases.fromPurchase");
  const titleOf = usePurchaseTitle();
  return useCallback(
    (line: PendingPurchaseLine) => {
      const purchase = titleOf(line.purchaseOrder);
      const supplier = line.purchaseOrder.supplier?.name;
      return t("lineLabel", {
        // A purchase without a reference is already titled by its supplier.
        purchase: supplier && line.purchaseOrder.reference ? `${purchase} · ${supplier}` : purchase,
        line: line.description,
        pending: line.pendingQuantity,
      });
    },
    [t, titleOf],
  );
}

/**
 * The optional "From purchase" picker (UX proposal §3.d, "catching the bypass"): one of the open ASSET
 * lines (a consumable line is received into stock, #1476), searched by purchase, supplier or line.
 * Choosing one hands the line to `onPick`; the caller switches to receiving against it.
 */
export function PendingLinePicker({
  id,
  lines,
  loading,
  onPick,
}: {
  id: string;
  lines: readonly PendingPurchaseLine[];
  loading: boolean;
  onPick: (line: PendingPurchaseLine) => void;
}) {
  const t = useTranslations("purchases.fromPurchase");
  const labelOf = usePendingLineLabel();
  const items = useMemo(
    () =>
      assetReceivableLines(lines).map((line) => ({
        value: line.id,
        label: labelOf(line),
        keywords: [line.purchaseOrder.reference, line.purchaseOrder.supplier?.name].filter(
          (term): term is string => Boolean(term),
        ),
      })),
    [lines, labelOf],
  );
  return (
    <Combobox
      id={id}
      value=""
      onValueChange={(value) => {
        const line = lines.find((candidate) => candidate.id === value);
        if (line) onPick(line);
      }}
      items={items}
      loading={loading}
      placeholder={t("placeholder")}
      searchPlaceholder={t("search")}
      emptyText={t("none")}
    />
  );
}

/**
 * The quiet suggestion under a chosen model: "1 unit of this model is pending on OC 4512 (Compumundo).
 * [Receive against it]". Renders nothing when no open line has the model.
 */
export function PendingLineSuggestion({
  modelId,
  lines,
  onPick,
}: {
  modelId: string;
  lines: readonly PendingPurchaseLine[];
  onPick: (line: PendingPurchaseLine) => void;
}) {
  const t = useTranslations("purchases.fromPurchase");
  const titleOf = usePurchaseTitle();
  const matches = pendingLinesForModel(lines, modelId).slice(0, 3);
  if (matches.length === 0) return null;
  return (
    <ul className="space-y-1.5" aria-label={t("suggestionLabel")}>
      {matches.map((line) => (
        <li key={line.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>
            {t("suggestion", {
              count: line.pendingQuantity,
              purchase: titleOf(line.purchaseOrder),
              supplier: line.purchaseOrder.supplier?.name ?? "—",
            })}
          </span>
          <button
            type="button"
            className="font-medium text-foreground underline-offset-4 hover:underline"
            onClick={() => onPick(line)}
          >
            {t("receiveAgainst")}
          </button>
        </li>
      ))}
    </ul>
  );
}
