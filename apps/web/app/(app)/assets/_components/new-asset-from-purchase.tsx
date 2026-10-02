"use client";

import { ShoppingCartIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Callout } from "@/components/callout";
import {
  PendingLinePicker,
  PendingLineSuggestion,
  type ReceiveLineTarget,
  useCanReceiveAgainstPurchases,
  useLoadLineTarget,
  useOpenLines,
} from "@/components/purchases/pending-line-picker";
import { ReceiveStockDialog } from "./receive-stock-dialog";

/**
 * "From purchase" on the New asset form (ADR-0099, UX proposal §3.d, "catching the bypass"): when a
 * purchase is still waiting for units, offer to receive against its line instead — the Receive stock
 * dialog in purchase mode, everything prefilled, the unit born linked. An asset create carries no purchase
 * line by design (linking is its own audited action), so the hand-off is the receive, not this form.
 *
 * Quiet by default: nothing renders without `purchaseOrder:read` and `:write` (and nothing is requested),
 * nor when no purchase waits for units. With a model chosen that open lines are mapped to, it says so.
 */
export function NewAssetFromPurchase({ modelId }: { modelId: string }) {
  const t = useTranslations("purchases.fromPurchase");
  const allowed = useCanReceiveAgainstPurchases();
  const openLines = useOpenLines(allowed);
  const loader = useLoadLineTarget();
  const [target, setTarget] = useState<ReceiveLineTarget | null>(null);
  const lines = openLines.data?.items ?? [];
  if (!allowed || lines.length === 0) return null;

  async function pick(line: (typeof lines)[number]) {
    const next = await loader.load(line);
    if (next) setTarget(next);
  }

  return (
    <>
      <Callout tone="info" icon={<ShoppingCartIcon />}>
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">{t("newAssetTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("newAssetHelp")}</p>
          </div>
          <div className="max-w-md">
            <PendingLinePicker
              id="new-asset-from-purchase"
              lines={lines}
              loading={loader.loading}
              onPick={(line) => void pick(line)}
            />
          </div>
          <PendingLineSuggestion modelId={modelId} lines={lines} onPick={(line) => void pick(line)} />
        </div>
      </Callout>
      {target ? <ReceiveStockDialog line={target} onClose={() => setTarget(null)} /> : null}
    </>
  );
}
