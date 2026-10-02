"use client";

import { ArrowDownTrayIcon, DocumentIcon, LinkIcon } from "@heroicons/react/24/outline";
import type { Asset, Attachment } from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { DetailField, DetailPanel } from "@/components/detail-panel";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { fetchAttachmentBlob } from "@/lib/api/endpoints/attachments";
import { useAssetPurchase, useUnlinkAssets } from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { failureViews } from "@/lib/purchases/link-apply";
import { costDiffersFromPurchase, purchasePanelMode } from "@/lib/purchases/provenance";
import { formatMoney } from "@/lib/utils/money";
import { usePurchaseTitle } from "@/app/(app)/purchases/_components/purchase-display";
import { LinkAssetsDialog } from "./link-assets-dialog";

type PanelAsset = Pick<
  Asset,
  "id" | "name" | "assetTag" | "modelId" | "purchaseCost" | "purchaseCurrency" | "purchaseOrderLineId" | "deletedAt"
>;

/**
 * The asset's *Purchase* panel (ADR-0099 §8 and §10, CEO decision D-A; UX proposal §2.3): where the asset
 * was bought — supplier, the purchase (linked), its dates and invoice numbers, the line, the supplier's
 * support contact for warranty claims, and the purchase's documents (the same rows, read-only here;
 * uploading and deleting happen on the purchase). Cost is the one value flagged *differs from purchase*.
 *
 * Shown only to a viewer holding `purchaseOrder:read`; without it the panel does not render and its read
 * is never made (the API refuses it too). An unlinked asset shows the panel only to someone who can link
 * it. An archived purchase stays the asset's provenance, shown as archived and without its documents.
 */
export function AssetPurchasePanel({ asset }: { asset: PanelAsset }) {
  const t = useTranslations("purchases.provenance");
  const canReadPurchases = useCan("purchaseOrder:read");
  const canWritePurchases = useCan("purchaseOrder:write");
  const canWriteAssets = useCan("asset:write");
  const canLink = canWritePurchases && canWriteAssets;
  const mode = purchasePanelMode({
    canReadPurchases,
    canLink,
    linked: Boolean(asset.purchaseOrderLineId),
    archived: asset.deletedAt != null,
  });
  const [linking, setLinking] = useState(false);

  if (mode === "hidden") return null;
  if (mode === "link") {
    return (
      <DetailPanel
        title={t("title")}
        actions={
          <Button variant="outline" size="sm" onClick={() => setLinking(true)}>
            <LinkIcon />
            {t("link")}
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">{t("notLinked")}</p>
        {linking ? (
          <LinkAssetsDialog
            assets={[{ id: asset.id, name: asset.name, assetTag: asset.assetTag, modelId: asset.modelId }]}
            onClose={() => setLinking(false)}
          />
        ) : null}
      </DetailPanel>
    );
  }
  return <Provenance asset={asset} canUnlink={canLink && asset.deletedAt == null} />;
}

function Provenance({ asset, canUnlink }: { asset: PanelAsset; canUnlink: boolean }) {
  const t = useTranslations("purchases.provenance");
  const tr = useTranslations("purchases.receipt");
  const treasons = useTranslations("purchases.link.reasons");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { date } = useFormatters();
  const titleOf = usePurchaseTitle();
  const { data, isLoading, isError } = useAssetPurchase(asset.id, { enabled: true });
  const unlink = useUnlinkAssets();
  const [confirming, setConfirming] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <DetailPanel title={t("title")}>
        <div className="space-y-2" aria-hidden>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </DetailPanel>
    );
  }
  if (isError || !data) {
    return (
      <DetailPanel title={t("title")}>
        <p className="text-sm text-muted-foreground">{t("loadError")}</p>
      </DetailPanel>
    );
  }

  const { purchaseOrder: purchase, line, documents } = data;
  const archived = purchase.deletedAt !== null;
  const title = titleOf({ ...purchase, createdAt: line.createdAt });
  const supplier = purchase.supplier;
  const differs = costDiffersFromPurchase(asset, line, purchase.currency);
  const support = supplier
    ? [supplier.supportContactName, supplier.supportContactEmail, supplier.supportContactPhone].filter(Boolean)
    : [];

  async function download(attachment: Attachment) {
    setDownloadingId(attachment.id);
    try {
      const blob = await fetchAttachmentBlob("purchaseOrder", purchase.id, attachment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.originalName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      notifyError(error, t("downloadError"));
    } finally {
      setDownloadingId(null);
    }
  }

  function confirmUnlink() {
    unlink.mutate(
      { id: purchase.id, lineId: line.id, assetIds: [asset.id] },
      {
        onSuccess: (outcome) => {
          setConfirming(false);
          const failure = failureViews(outcome.failed, new Map())[0];
          if (failure) {
            toast.error(failure.reasonKey ? treasons(failure.reasonKey) : failure.error);
            return;
          }
          toast.success(t("unlinkedToast"));
        },
        onError: (error) => notifyError(error, t("unlinkError")),
      },
    );
  }

  return (
    <DetailPanel
      title={t("title")}
      actions={
        canUnlink ? (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            {t("unlink")}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-muted-foreground">{t("from")}</span>
          {archived ? (
            <>
              <span className="font-medium">{title}</span>
              <Badge variant="outline">{t("archived")}</Badge>
            </>
          ) : (
            <Link href={`/purchases/${purchase.id}`} className="font-medium hover:underline">
              {title}
            </Link>
          )}
          {supplier ? <span>· {supplier.name}</span> : null}
        </div>
        <p className="text-sm">
          {line.description}
          {line.receiptState !== null ? (
            <span className="text-muted-foreground">
              {" · "}
              {tr("progress", { received: line.receivedQuantity, ordered: line.quantity })}
            </span>
          ) : null}
        </p>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailField label={t("reference")} mono>
            {purchase.reference ?? "—"}
          </DetailField>
          <DetailField label={t("currency")}>
            {purchase.currency ?? <span className="text-muted-foreground">{t("noCurrency")}</span>}
          </DetailField>
          <DetailField label={t("orderDate")} mono>
            {purchase.orderDate ? date(purchase.orderDate) : "—"}
          </DetailField>
          <DetailField label={t("invoiceDate")} mono>
            {purchase.invoiceDate ? date(purchase.invoiceDate) : "—"}
          </DetailField>
          <DetailField label={t("invoiceNumbers")} mono>
            {purchase.invoiceNumbers ?? "—"}
          </DetailField>
          <DetailField label={t("linePrice")} mono>
            {line.unitPrice !== null ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                {formatMoney(line.unitPrice, locale, purchase.currency)}
                {differs ? <StatusBadge tone="neutral">{t("differs")}</StatusBadge> : null}
              </span>
            ) : (
              "—"
            )}
          </DetailField>
          {support.length > 0 ? (
            <DetailField label={t("support")} className="sm:col-span-2">
              <span className="inline-flex flex-wrap gap-x-2">
                {supplier?.supportContactName ? <span>{supplier.supportContactName}</span> : null}
                {supplier?.supportContactEmail ? (
                  <a href={`mailto:${supplier.supportContactEmail}`} className="hover:underline">
                    {supplier.supportContactEmail}
                  </a>
                ) : null}
                {supplier?.supportContactPhone ? <span className="font-mono">{supplier.supportContactPhone}</span> : null}
              </span>
            </DetailField>
          ) : null}
        </dl>
        {differs ? <p className="text-xs text-muted-foreground">{t("differsHelp")}</p> : null}

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t("documents")}</p>
          {archived ? (
            <p className="text-sm text-muted-foreground">{t("archivedDocuments")}</p>
          ) : documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noDocuments")}</p>
          ) : (
            <ul className="divide-y">
              {documents.map((attachment) => (
                <li key={attachment.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <DocumentIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate text-sm">{attachment.originalName}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{date(attachment.createdAt)}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("downloadAria", { name: attachment.originalName })}
                    onClick={() => void download(attachment)}
                    disabled={downloadingId === attachment.id}
                  >
                    <ArrowDownTrayIcon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("unlinkTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("unlinkDescription", { asset: asset.assetTag ?? asset.name, purchase: title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unlink.isPending}>{tc("cancel")}</AlertDialogCancel>
            <Button variant="destructive" disabled={unlink.isPending} onClick={confirmUnlink}>
              {t("unlink")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailPanel>
  );
}
