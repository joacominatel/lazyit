"use client";

import type { AssetListItem, PurchaseOrderLine } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAssets } from "@/lib/api/hooks/use-assets";
import { useUnlinkAssets } from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { failureViews } from "@/lib/purchases/link-apply";
import { lineAssetsFilters } from "@/lib/purchases/linked-assets";
import { cn } from "@/lib/utils";

/**
 * The assets linked to one purchase line (#1476), read only when the operator opens them — the purchase
 * page stays light — through `GET /assets?purchaseOrderLineId=`, which needs `purchaseOrder:read` (without
 * it nothing is requested). Each asset links to its page; with `purchaseOrder:write` + `asset:write` it can
 * be unlinked from here, the line side of the asset's *Unlink from purchase*. Unlinking never clears the
 * asset's purchase values.
 */
export function LineAssets({ purchaseId, line }: { purchaseId: string; line: PurchaseOrderLine }) {
  const canReadPurchases = useCan("purchaseOrder:read");
  const filters = lineAssetsFilters(line.id, canReadPurchases);
  if (!filters) return null;
  return <LineAssetsList purchaseId={purchaseId} line={line} filters={filters} />;
}

function LineAssetsList({
  purchaseId,
  line,
  filters,
}: {
  purchaseId: string;
  line: PurchaseOrderLine;
  filters: NonNullable<ReturnType<typeof lineAssetsFilters>>;
}) {
  const t = useTranslations("purchases.lineAssets");
  const treasons = useTranslations("purchases.link.reasons");
  const tc = useTranslations("common");
  const canWritePurchases = useCan("purchaseOrder:write");
  const canWriteAssets = useCan("asset:write");
  const canUnlink = canWritePurchases && canWriteAssets;
  const { data, isLoading, isError, isFetching } = useAssets(filters);
  const unlink = useUnlinkAssets();
  const [unlinking, setUnlinking] = useState<AssetListItem | null>(null);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  function confirmUnlink(asset: AssetListItem) {
    unlink.mutate(
      { id: purchaseId, lineId: line.id, assetIds: [asset.id] },
      {
        onSuccess: (outcome) => {
          setUnlinking(null);
          const failure = failureViews(outcome.failed, new Map())[0];
          if (failure) {
            toast.error(failure.reasonKey ? treasons(failure.reasonKey) : failure.error);
            return;
          }
          toast.success(t("unlinkedToast", { asset: asset.assetTag ?? asset.name }));
        },
        onError: (error) => notifyError(error, t("unlinkError")),
      },
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-2/3" />
      </div>
    );
  }
  if (isError) return <p className="text-sm text-muted-foreground">{t("loadError")}</p>;
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{t("none")}</p>;

  return (
    <div className="space-y-2">
      <ul className={cn("divide-y rounded-md border bg-background", isFetching && "opacity-70")}>
        {items.map((asset) => (
          <li key={asset.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <Link href={`/assets/${asset.id}`} className="font-medium hover:underline">
                {asset.name}
              </Link>
              <span className="block truncate font-mono text-xs text-muted-foreground">
                {[asset.assetTag, asset.serial].filter(Boolean).join(" · ") || "—"}
              </span>
            </div>
            {canUnlink ? (
              <Button variant="ghost" size="sm" onClick={() => setUnlinking(asset)}>
                {t("unlink")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {total > items.length ? (
        <p className="text-xs text-muted-foreground">{t("showingSome", { shown: items.length, total })}</p>
      ) : null}

      <AlertDialog open={unlinking !== null} onOpenChange={(open) => !open && setUnlinking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("unlinkTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("unlinkDescription", {
                asset: unlinking?.assetTag ?? unlinking?.name ?? "",
                line: line.description,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unlink.isPending}>{tc("cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={unlink.isPending}
              onClick={() => unlinking && confirmUnlink(unlinking)}
            >
              {t("unlink")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
