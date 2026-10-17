"use client";

import {
  ChevronDownIcon,
  DocumentMagnifyingGlassIcon,
  EllipsisVerticalIcon,
  ExclamationTriangleIcon,
  InboxArrowDownIcon,
  KeyIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { PurchaseOrderLine, PurchaseOrderStatus } from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "@/components/breadcrumb";
import { Callout } from "@/components/callout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailField, DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { useAssetModels } from "@/lib/api/hooks/use-asset-models";
import { useConsumable } from "@/lib/api/hooks/use-consumables";
import { useLocation } from "@/lib/api/hooks/use-locations";
import {
  useDeletePurchaseOrder,
  useExtractionStatus,
  usePurchaseOrder,
  useRemovePurchaseOrderLine,
  useUpdatePurchaseOrder,
} from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { canCancelPurchase } from "@/lib/purchases/display";
import { canAskAiToFill, canExtract, documentNameForPrompt, unavailableHint } from "@/lib/purchases/extraction";
import { lineReceiveAction } from "@/lib/purchases/pending";
import { formatMoney } from "@/lib/utils/money";
import { ApplyLicenseDialog, useCanApplyLicense } from "@/components/purchases/apply-license-dialog";
import { CancelRemainingDialog } from "@/components/purchases/cancel-remaining-dialog";
import { LinkAssetsDialog } from "@/components/purchases/link-assets-dialog";
import { ReceiveIntoStockDialog, useCanReceiveStock } from "@/components/purchases/receive-into-stock-dialog";
import { ReceiveStockDialog } from "../../../assets/_components/receive-stock-dialog";
import { DocumentsPanel } from "../../../assets/[id]/_components/asset-documents-panel";
import { useAiAssistant } from "@/components/ai/ai-assistant-root";
import { AiChatIcon } from "@/components/ai/ai-icons";
import {
  MoneyTotals,
  PurchaseStatusBadge,
  ReceiptBar,
  ReceiptSummary,
  usePurchaseTitle,
} from "../../_components/purchase-display";
import { LineAssets } from "./line-assets";
import { LineDialog } from "./line-dialog";
import { PurchaseActivity } from "./purchase-activity";

/**
 * A line's received cell: "x of y" for a countable line — seats applied for a license line (#1477) —,
 * over-received as a warning, "—" otherwise.
 */
function LineReceipt({ line }: { line: PurchaseOrderLine }) {
  const t = useTranslations("purchases.receipt");
  if (line.receiptState === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono tabular-nums">
        {line.kind === "LICENSE"
          ? t("seatsApplied", { applied: line.receivedQuantity, ordered: line.quantity })
          : t("progress", { received: line.receivedQuantity, ordered: line.quantity })}
      </span>
      {line.cancelledQuantity > 0 ? (
        <span className="text-muted-foreground">{t("cancelled", { count: line.cancelledQuantity })}</span>
      ) : null}
      {line.receiptState === "OVER" ? <StatusBadge tone="warning">{t("over")}</StatusBadge> : null}
    </span>
  );
}

/**
 * The consumable a consumable line receives into (#1476): its name, linked to its page. Read only with
 * `consumable:read` — otherwise nothing is requested and nothing is shown.
 */
function LineConsumable({ consumableId }: { consumableId: string | null | undefined }) {
  const t = useTranslations("purchases.detail");
  const canRead = useCan("consumable:read");
  const { data } = useConsumable(canRead && consumableId ? consumableId : undefined);
  if (!canRead) return null;
  if (!consumableId) return <span>{t("consumableNotMapped")}</span>;
  if (!data) return null;
  return (
    <span>
      {t.rich("receivesInto", {
        name: data.name,
        link: (chunks) => (
          <Link href={`/consumables/${data.id}`} className="hover:underline">
            {chunks}
          </Link>
        ),
      })}
    </span>
  );
}

/**
 * The application a license line's seats are for (#1477): its name, linked to its page. Read only with
 * `application:read` — otherwise nothing is requested and nothing is shown.
 */
function LineApplication({ applicationId }: { applicationId: string | null | undefined }) {
  const t = useTranslations("purchases.detail");
  const canRead = useCan("application:read");
  const { data } = useApplication(canRead && applicationId ? applicationId : undefined);
  if (!canRead) return null;
  if (!applicationId) return <span>{t("applicationNotMapped")}</span>;
  if (!data) return null;
  return (
    <span>
      {t.rich("seatsFor", {
        name: data.name,
        link: (chunks) => (
          <Link href={`/applications/${data.id}`} className="hover:underline">
            {chunks}
          </Link>
        ),
      })}
    </span>
  );
}

/**
 * One purchase (ADR-0099, UX proposal §3.a "Purchase detail"): identity, status and receipt progress;
 * the lines with "x of y received" (over-received is a warning, never an error); totals per currency
 * label; the status actions; receiving units, linking existing assets and cancelling the remaining units
 * per line (#1475); consumable lines received into stock (#1476); license lines applied to their
 * application (#1477); the purchase's documents — each readable into a reviewed draft when document
 * extraction is on (#1477); and the activity log.
 */
export function PurchaseDetailView({ id }: { id: string }) {
  const t = useTranslations("purchases");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const { date } = useFormatters();
  const titleOf = usePurchaseTitle();
  const canWrite = useCan("purchaseOrder:write");
  const canDelete = useCan("purchaseOrder:delete");
  // Receiving creates assets: it needs both purchase and asset write (the API checks both).
  const canWriteAssets = useCan("asset:write");
  const canReceive = canWrite && canWriteAssets;
  // Receiving a consumable line posts stock: purchase and consumable write (#1476).
  const canReceiveStock = useCanReceiveStock();
  // Applying a license line changes its application: purchase and application write (#1477).
  const canApplyLicense = useCanApplyLicense();
  // Reading a document into a reviewed draft (#1477): offered only where the status says so; only an admin,
  // who can change Settings → AI, is told why it is not.
  const isAdmin = useCan("settings:manage");
  const { data: extraction } = useExtractionStatus({ enabled: canWrite });
  const extractionHint = extraction && !extraction.available ? unavailableHint(extraction.reason, isAdmin) : null;
  // Or in the chat (#1478): the assistant opens on this page with a message to read the document, which the
  // person sends — it reads the document as untrusted data and proposes the purchase as cards.
  const assistant = useAiAssistant();

  const { data: purchase, isLoading, isError, error, refetch } = usePurchaseOrder(id);
  const { data: location } = useLocation(purchase?.deliveryLocationId ?? undefined);
  const { data: models } = useAssetModels();
  const updatePurchase = useUpdatePurchaseOrder();
  const deletePurchase = useDeletePurchaseOrder();
  const removeLine = useRemovePurchaseOrderLine();

  const [lineDialog, setLineDialog] = useState<{ line?: PurchaseOrderLine } | null>(null);
  const [receiving, setReceiving] = useState<PurchaseOrderLine | null>(null);
  const [receivingStock, setReceivingStock] = useState<PurchaseOrderLine | null>(null);
  const [applyingLicense, setApplyingLicense] = useState<PurchaseOrderLine | null>(null);
  const [cancelling, setCancelling] = useState<PurchaseOrderLine | null>(null);
  const [linking, setLinking] = useState<PurchaseOrderLine | null>(null);
  const [removing, setRemoving] = useState<PurchaseOrderLine | null>(null);
  // Lines whose linked assets are open — read only on demand, so the page stays light (#1476).
  const [openAssets, setOpenAssets] = useState<ReadonlySet<string>>(new Set());
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const modelName = useMemo(
    () => new Map((models ?? []).map((m) => [m.id, `${m.manufacturer} ${m.name}`])),
    [models],
  );

  const title = purchase ? titleOf(purchase) : "";
  const breadcrumb = useMemo(
    () => <Breadcrumb items={[{ label: t("list.title"), href: "/purchases" }, { label: title }]} />,
    [t, title],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl">
        <DetailSkeleton panels={3} />
      </div>
    );
  }
  if (isError || !purchase) {
    return (
      <div className="mx-auto max-w-5xl">
        <ErrorState
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  function setStatus(status: PurchaseOrderStatus) {
    updatePurchase.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          toast.success(t("detail.statusToast"));
          setConfirmCancel(false);
        },
        onError: (err) => notifyError(err, t("detail.statusError")),
      },
    );
  }

  function confirmRemoveLine(line: PurchaseOrderLine) {
    removeLine.mutate(
      { id, lineId: line.id },
      {
        onSuccess: () => {
          toast.success(t("detail.lineRemovedToast"));
          setRemoving(null);
        },
        onError: (err) => notifyError(err, t("detail.lineRemoveError")),
      },
    );
  }

  const currency = purchase.currency ?? "";
  const cancellable = canCancelPurchase(purchase.status, purchase.receipt);
  const statusItems: { status: PurchaseOrderStatus; label: string }[] = [
    { status: "DRAFT" as const, label: t("detail.markDraft") },
    { status: "ORDERED" as const, label: t("detail.markOrdered") },
  ].filter((item) => item.status !== purchase.status);
  const subtitle = [
    purchase.supplier?.name,
    purchase.orderDate ? t("detail.orderedOn", { date: date(purchase.orderDate) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        breadcrumb={breadcrumb}
        title={title}
        badge={<PurchaseStatusBadge status={purchase.status} receipt={purchase.receipt} />}
        subtitle={subtitle || undefined}
        actions={
          canWrite || canDelete ? (
            <>
              {canWrite ? (
                <>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/purchases/${purchase.id}/edit`}>
                      <PencilSquareIcon />
                      {tc("edit")}
                    </Link>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        {t("detail.statusAction")}
                        <ChevronDownIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {statusItems.map((item) => (
                        <DropdownMenuItem
                          key={item.status}
                          disabled={updatePurchase.isPending}
                          onSelect={() => setStatus(item.status)}
                        >
                          {item.label}
                        </DropdownMenuItem>
                      ))}
                      {cancellable ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmCancel(true)}>
                            {t("detail.cancelPurchase")}
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("detail.archiveAction")}
                  onClick={() => setDeleteOpen(true)}
                >
                  <TrashIcon />
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      <DetailPanel title={t("detail.summarySection")}>
        {purchase.receipt ? (
          <div className="mb-5 space-y-2">
            <ReceiptBar receipt={purchase.receipt} />
            <ReceiptSummary receipt={purchase.receipt} className="text-sm" />
          </div>
        ) : null}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailField label={t("detail.supplier")}>
            {purchase.supplier ? (
              purchase.supplier.deletedAt ? (
                <span className="inline-flex items-center gap-2">
                  {purchase.supplier.name}
                  <Badge variant="outline">{t("detail.archivedSupplier")}</Badge>
                </span>
              ) : (
                <Link href={`/purchases/suppliers/${purchase.supplier.id}`} className="hover:underline">
                  {purchase.supplier.name}
                </Link>
              )
            ) : (
              "—"
            )}
          </DetailField>
          <DetailField label={t("detail.reference")} mono>
            {purchase.reference ?? "—"}
          </DetailField>
          <DetailField label={t("detail.currency")}>
            {purchase.currency ?? <span className="text-muted-foreground">{t("totals.noCurrency")}</span>}
          </DetailField>
          <DetailField label={t("detail.orderDate")} mono>
            {purchase.orderDate ? date(purchase.orderDate) : "—"}
          </DetailField>
          <DetailField label={t("detail.expectedDate")} mono>
            {purchase.expectedDate ? date(purchase.expectedDate) : "—"}
          </DetailField>
          <DetailField label={t("detail.deliveryLocation")}>
            {purchase.deliveryLocationId && location ? (
              <Link href={`/locations/${location.id}`} className="hover:underline">
                {location.name}
              </Link>
            ) : (
              "—"
            )}
          </DetailField>
          <DetailField label={t("detail.company")}>{purchase.company ?? "—"}</DetailField>
          <DetailField label={t("detail.invoiceNumbers")} mono>
            {purchase.invoiceNumbers ?? "—"}
          </DetailField>
          <DetailField label={t("detail.invoiceDate")} mono>
            {purchase.invoiceDate ? date(purchase.invoiceDate) : "—"}
          </DetailField>
          <DetailField label={t("detail.total")}>
            <MoneyTotals totals={purchase.totals} />
          </DetailField>
        </dl>
        {purchase.notes ? (
          <dl className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">{t("detail.notes")}</dt>
            <dd className="text-sm whitespace-pre-wrap">{purchase.notes}</dd>
          </dl>
        ) : null}
      </DetailPanel>

      <DetailPanel
        title={t("detail.linesSection")}
        actions={
          canWrite ? (
            <Button variant="outline" size="sm" onClick={() => setLineDialog({})}>
              <PlusIcon />
              {t("detail.addLine")}
            </Button>
          ) : undefined
        }
      >
        {purchase.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("detail.noLines")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("detail.lineColumns.item")}</TableHead>
                  <TableHead className="text-right">{t("detail.lineColumns.quantity")}</TableHead>
                  <TableHead className="text-right">{t("detail.lineColumns.unitPrice")}</TableHead>
                  <TableHead className="text-right">{t("detail.lineColumns.lineTotal")}</TableHead>
                  <TableHead>{t("detail.lineColumns.received")}</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">{t("detail.lineColumns.actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchase.lines.map((line) => {
                  const brand = [line.manufacturerText, line.modelText].filter(Boolean).join(" ");
                  const mapped = line.assetModelId ? modelName.get(line.assetModelId) : undefined;
                  const hasAssets = line.kind === "ASSET" && line.receivedQuantity > 0;
                  // What Receive means for this kind — never an asset receive for a license line (#1477).
                  const action = lineReceiveAction(line.kind);
                  const assetsOpen = hasAssets && openAssets.has(line.id);
                  return (
                    <Fragment key={line.id}>
                      <TableRow>
                        <TableCell className="min-w-56 align-top">
                          <div className="flex items-start gap-2">
                            <Badge variant="outline" className="shrink-0">
                              {line.kind === "ASSET"
                                ? t("line.kindAsset")
                                : line.kind === "CONSUMABLE"
                                  ? t("line.kindConsumable")
                                  : line.kind === "LICENSE"
                                    ? t("line.kindLicense")
                                    : line.kind === "OTHER"
                                      ? t("line.kindOther")
                                      : line.kind}
                            </Badge>
                            <div className="min-w-0 space-y-0.5">
                              <p className="font-medium">{line.description}</p>
                              {brand || mapped || line.warrantyMonths != null ? (
                                <p className="text-xs text-muted-foreground">
                                  {[
                                    brand || null,
                                    mapped ? t("detail.mappedTo", { model: mapped }) : null,
                                    line.warrantyMonths != null
                                      ? t("detail.warranty", { months: line.warrantyMonths })
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </p>
                              ) : null}
                              {line.kind === "CONSUMABLE" ? (
                                <p className="text-xs text-muted-foreground">
                                  <LineConsumable consumableId={line.consumableId} />
                                </p>
                              ) : null}
                              {line.kind === "LICENSE" ? (
                                <p className="text-xs text-muted-foreground">
                                  <LineApplication applicationId={line.applicationId} />
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right align-top font-mono tabular-nums">
                          {line.quantity}
                        </TableCell>
                        <TableCell className="text-right align-top font-mono tabular-nums">
                          {line.unitPrice != null ? (
                            formatMoney(line.unitPrice, locale, purchase.currency)
                          ) : (
                            <span className="text-muted-foreground">{t("detail.noPrice")}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right align-top font-mono tabular-nums">
                          {line.lineTotal != null ? formatMoney(line.lineTotal, locale, purchase.currency) : "—"}
                        </TableCell>
                        <TableCell className="align-top text-sm">
                          <LineReceipt line={line} />
                          {hasAssets ? (
                            <button
                              type="button"
                              className="mt-1 block text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                              aria-expanded={assetsOpen}
                              aria-controls={`line-assets-${line.id}`}
                              onClick={() =>
                                setOpenAssets((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(line.id)) next.delete(line.id);
                                  else next.add(line.id);
                                  return next;
                                })
                              }
                            >
                              {assetsOpen ? t("lineAssets.hide") : t("lineAssets.show")}
                            </button>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right align-top">
                          <div className="flex items-center justify-end gap-1">
                            {canReceive && action === "receiveAssets" && line.pendingQuantity > 0 ? (
                              <Button variant="outline" size="sm" onClick={() => setReceiving(line)}>
                                <InboxArrowDownIcon />
                                {t("detail.receive")}
                              </Button>
                            ) : null}
                            {canReceiveStock && action === "receiveStock" && line.pendingQuantity > 0 ? (
                              <Button variant="outline" size="sm" onClick={() => setReceivingStock(line)}>
                                <InboxArrowDownIcon />
                                {t("detail.receive")}
                              </Button>
                            ) : null}
                            {canApplyLicense && action === "applyLicense" && line.pendingQuantity > 0 ? (
                              <Button variant="outline" size="sm" onClick={() => setApplyingLicense(line)}>
                                <KeyIcon />
                                {t("detail.applyLicense")}
                              </Button>
                            ) : null}
                            {canWrite ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={t("detail.lineActions", { line: line.description })}
                                  >
                                    <EllipsisVerticalIcon />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {canReceive && action === "receiveAssets" ? (
                                    <>
                                      <DropdownMenuItem onSelect={() => setReceiving(line)}>
                                        {t("detail.receiveUnits")}
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onSelect={() => setLinking(line)}>
                                        {t("detail.linkExisting")}
                                      </DropdownMenuItem>
                                    </>
                                  ) : null}
                                  {canReceiveStock && action === "receiveStock" ? (
                                    <DropdownMenuItem onSelect={() => setReceivingStock(line)}>
                                      {t("detail.receiveStock")}
                                    </DropdownMenuItem>
                                  ) : null}
                                  {canApplyLicense && action === "applyLicense" ? (
                                    <DropdownMenuItem onSelect={() => setApplyingLicense(line)}>
                                      {t("detail.applyLicense")}
                                    </DropdownMenuItem>
                                  ) : null}
                                  <DropdownMenuItem onSelect={() => setLineDialog({ line })}>
                                    {t("detail.editLine")}
                                  </DropdownMenuItem>
                                  {line.pendingQuantity > 0 ? (
                                    <DropdownMenuItem onSelect={() => setCancelling(line)}>
                                      {t("detail.cancelRemaining")}
                                    </DropdownMenuItem>
                                  ) : null}
                                  {line.receivedQuantity === 0 ? (
                                    <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(line)}>
                                      {t("detail.removeLine")}
                                    </DropdownMenuItem>
                                  ) : null}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                      {assetsOpen ? (
                        <TableRow id={`line-assets-${line.id}`} className="hover:bg-transparent">
                          <TableCell colSpan={6} className="bg-muted/30">
                            <LineAssets purchaseId={purchase.id} line={line} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </DetailPanel>

      <DocumentsPanel
        parent="purchaseOrder"
        parentId={purchase.id}
        canWrite={canWrite}
        notice={
          <>
            {/* ADR-0099 §12: purchase documents are financial evidence, and the attachments volume is not in
                the backup yet (docs/05-runbooks/backups.md, item #7). Say so where the files are uploaded. */}
            <Callout tone="warning" icon={<ExclamationTriangleIcon />} className="mb-3">
              <p className="text-sm">{t("detail.documentsBackupNotice")}</p>
            </Callout>
            {extractionHint ? (
              <p className="mb-3 text-xs text-muted-foreground">
                {t.rich(`extraction.hint.${extractionHint}`, {
                  link: (chunks) => (
                    <Link href="/settings/ai?tab=capabilities" className="font-medium text-foreground hover:underline">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            ) : null}
          </>
        }
        rowAction={(attachment) =>
          canExtract(extraction, attachment) ? (
            <>
              <Button variant="ghost" size="sm" asChild>
                <Link
                  href={`/purchases/${purchase.id}/review/${attachment.id}?read=1`}
                  // The one-line disclosure: what clicking sends, and that nothing is saved yet.
                  title={t("detail.readDocumentHint")}
                >
                  <DocumentMagnifyingGlassIcon />
                  <span className="sr-only sm:not-sr-only">{t("detail.readDocument")}</span>
                </Link>
              </Button>
              {canAskAiToFill(assistant.available, extraction, attachment) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  title={t("detail.askAiHint")}
                  onClick={() =>
                    assistant.ask(
                      t("detail.askAiMessage", {
                        name: documentNameForPrompt(attachment.originalName),
                        // The id lets the assistant read exactly this document (purchase_document_read).
                        id: attachment.id,
                      }),
                    )
                  }
                >
                  <AiChatIcon />
                  <span className="sr-only sm:not-sr-only">{t("detail.askAi")}</span>
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <DetailPanel title={t("detail.activitySection")}>
        <PurchaseActivity purchaseId={purchase.id} lines={purchase.lines} />
      </DetailPanel>

      {receiving ? (
        <ReceiveStockDialog
          line={{ purchase, line: receiving }}
          onClose={() => setReceiving(null)}
        />
      ) : null}

      {receivingStock ? (
        <ReceiveIntoStockDialog
          purchase={purchase}
          line={receivingStock}
          onClose={() => setReceivingStock(null)}
        />
      ) : null}

      {applyingLicense ? (
        <ApplyLicenseDialog
          purchase={purchase}
          line={applyingLicense}
          onClose={() => setApplyingLicense(null)}
        />
      ) : null}

      {linking ? (
        <LinkAssetsDialog line={{ purchase, line: linking }} onClose={() => setLinking(null)} />
      ) : null}

      {cancelling ? (
        <CancelRemainingDialog
          purchaseId={purchase.id}
          line={cancelling}
          onClose={() => setCancelling(null)}
        />
      ) : null}

      {lineDialog ? (
        <LineDialog
          open
          onOpenChange={(open) => {
            if (!open) setLineDialog(null);
          }}
          purchaseId={purchase.id}
          currency={currency}
          line={lineDialog.line}
        />
      ) : null}

      <AlertDialog open={removing != null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("detail.removeLineTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("detail.removeLineDescription", { line: removing?.description ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeLine.isPending}>{tc("cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={removeLine.isPending}
              onClick={() => removing && confirmRemoveLine(removing)}
            >
              {t("detail.removeLine")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("detail.cancelTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("detail.cancelDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updatePurchase.isPending}>{t("detail.keepPurchase")}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={updatePurchase.isPending}
              onClick={() => setStatus("CANCELLED")}
            >
              {t("detail.cancelPurchase")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityKey="purchase"
        name={title}
        onConfirm={() => deletePurchase.mutateAsync(purchase.id)}
        onDeleted={() => router.push("/purchases")}
      >
        {t("list.archiveNote")}
      </DeleteConfirmDialog>
    </div>
  );
}
