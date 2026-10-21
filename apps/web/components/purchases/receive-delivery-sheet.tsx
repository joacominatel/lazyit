"use client";

import {
  ArrowPathIcon,
  CameraIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  MinusIcon,
  PlusIcon,
  QrCodeIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { ASSET_ATTACHMENT_MAX_MB, type PurchaseOrderDetail, type PurchaseOrderLine } from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AssetModelCombobox } from "@/components/asset-model-combobox";
import { Callout } from "@/components/callout";
import { ConsumableCombobox } from "@/components/consumable-combobox";
import { CreatableField } from "@/components/creatable-field";
import { CreateAssetModelDialog } from "@/components/create-asset-model-dialog";
import { LocationCombobox } from "@/components/location-combobox";
import { OpenPurchaseButton } from "@/components/purchases/open-purchase-button";
import { useCanReceiveStock } from "@/components/purchases/receive-into-stock-dialog";
import { ErrorState } from "@/components/resource-table";
import { SerialScanner } from "@/components/serial-scanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useUploadAttachment } from "@/lib/api/hooks/use-attachments";
import {
  usePurchaseOrder,
  useReceiveFromLine,
  useReceiveStock,
  useUpdatePurchaseOrderLine,
} from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { localToday } from "@/lib/purchases/pending";
import {
  addScannedSerial,
  assetOutcome,
  buildDeliveryPlan,
  DELIVERY_NOTE_ACCEPT,
  type DeliveryAccess,
  type DeliveryKind,
  deliveryLines,
  type DeliveryOutcome,
  deliveryPrefill,
  type DeliveryRow,
  type DeliveryRowError,
  type DeliveryShared,
  deliveryUnits,
  initialRow,
  rowQuantity,
  setRowQuantity,
  setRowSerials,
  stepRow,
  summarizeDelivery,
} from "@/lib/purchases/receive-delivery";
import { planUpload } from "@/lib/utils/document-label";
import { overReceipt, parseSerials } from "@/app/(app)/assets/_components/receive-stock-payload";
import { AssetStatusSelect, useAssetStatusOptions } from "@/app/(app)/assets/_components/asset-status-picker";
import { usePurchaseTitle } from "@/app/(app)/purchases/_components/purchase-display";

/**
 * What the viewer may receive in a delivery, as the routes check it: assets need `purchaseOrder:write` +
 * `asset:write`, stock `purchaseOrder:write` + `consumable:write` (#1497).
 */
export function useDeliveryAccess(): DeliveryAccess {
  const canWritePurchases = useCan("purchaseOrder:write");
  const canWriteAssets = useCan("asset:write");
  const stock = useCanReceiveStock();
  return useMemo(() => ({ assets: canWritePurchases && canWriteAssets, stock }), [canWritePurchases, canWriteAssets, stock]);
}

/** Whether a purchase's lines give this viewer anything to receive in a delivery. */
export function hasDeliveryLines(
  lines: readonly Pick<PurchaseOrderLine, "kind" | "pendingQuantity">[],
  access: DeliveryAccess,
): boolean {
  return deliveryLines(lines, access).length > 0;
}

/** The message of a failed request, for the per-line result. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * *Receive delivery* (ADR-0099 Phase 1b, UX proposal §6, #1497): one delivery received across several lines of
 * one purchase — the boxes at the door, counted line by line. One row per `ASSET` or `CONSUMABLE` line the
 * viewer may receive, each starting at 0, with serials (and *Scan*) once an asset row counts a unit; ONE set of
 * delivery values every asset unit shares (purchase date, status, location), prefilled from the purchase; an
 * inline model (or consumable) pick for an unmapped line, saved on the line as the single receive does; and an
 * optional delivery-note photo, uploaded to the purchase's documents labelled *Delivery note*.
 *
 * Submit runs the EXISTING routes, one request per line, in order — no new API — and shows the combined
 * partial-success result per line. The purchase is read here (from the cache when the page has it), so both
 * entry points — the purchase header and *Pending units* — pass only its id. Mounted only while open.
 */
export function ReceiveDeliverySheet({ purchaseId, onClose }: { purchaseId: string; onClose: () => void }) {
  const t = useTranslations("purchases.receiveDelivery");
  const { data: purchase, isLoading, isError, error, refetch } = usePurchaseOrder(purchaseId);
  const access = useDeliveryAccess();

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      >
        {isLoading ? (
          <div className="space-y-3 p-5" aria-busy>
            <SheetTitle className="sr-only">{t("title")}</SheetTitle>
            <SheetDescription className="sr-only">{t("loading")}</SheetDescription>
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : isError || !purchase ? (
          <div className="p-5">
            <SheetTitle className="sr-only">{t("title")}</SheetTitle>
            <SheetDescription className="sr-only">{t("loadError")}</SheetDescription>
            <ErrorState title={t("loadError")} onRetry={() => refetch()} error={error} />
          </div>
        ) : (
          <DeliveryBody purchase={purchase} access={access} onClose={onClose} />
        )}
      </SheetContent>
    </Sheet>
  );
}

type Progress = { current: number; total: number };
type NoteOutcome = "uploaded" | "failed" | null;

function DeliveryBody({
  purchase,
  access,
  onClose,
}: {
  purchase: PurchaseOrderDetail;
  access: DeliveryAccess;
  onClose: () => void;
}) {
  const t = useTranslations("purchases.receiveDelivery");
  const ta = useTranslations("assets.receive");
  const tl = useTranslations("assets.receive.line");
  const tdocs = useTranslations("attachments.docs");
  const tc = useTranslations("common");
  const locale = useLocale();
  const titleOf = usePurchaseTitle();
  const statusGroups = useAssetStatusOptions();
  const receiveLine = useReceiveFromLine();
  const receiveStock = useReceiveStock();
  const updateLine = useUpdatePurchaseOrderLine();
  const upload = useUploadAttachment("purchaseOrder", purchase.id);

  // The rows are fixed when the sheet opens: a line received meanwhile keeps its row, so the sheet never
  // reshuffles under the operator's hands. Each row reads its line fresh from the purchase.
  const [lineIds] = useState(() => deliveryLines(purchase.lines, access).map((line) => line.id));
  const lines = useMemo(() => {
    const byId = new Map(purchase.lines.map((line) => [line.id, line]));
    return lineIds.map((id) => byId.get(id)).filter((line): line is PurchaseOrderLine => line !== undefined);
  }, [purchase.lines, lineIds]);
  const [rows, setRows] = useState<Record<string, DeliveryRow>>(() =>
    Object.fromEntries(
      purchase.lines.filter((line) => lineIds.includes(line.id)).map((line) => [line.id, initialRow(line)]),
    ),
  );
  const [initial] = useState(() => deliveryPrefill(purchase, localToday()));
  const [shared, setShared] = useState<DeliveryShared>(initial.shared);
  const [photo, setPhoto] = useState<File | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, DeliveryRowError>>({});
  const [emptyError, setEmptyError] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<{ outcomes: DeliveryOutcome[]; note: NoteOutcome } | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const hasAssetRows = lines.some((line) => line.kind === "ASSET");
  const units = deliveryUnits(rows, lineIds);
  const busy = progress !== null;

  function patchRow(lineId: string, update: (row: DeliveryRow) => DeliveryRow) {
    setRows((prev) => (prev[lineId] ? { ...prev, [lineId]: update(prev[lineId]) } : prev));
    setErrors((prev) => {
      if (!prev[lineId]) return prev;
      const next = { ...prev };
      delete next[lineId];
      return next;
    });
    setEmptyError(false);
  }

  function pickPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const { accepted, refused } = planUpload([file], "");
    for (const { file: bad, reason } of refused) {
      toast.error(
        reason === "tooLarge"
          ? tdocs("tooLarge", { name: bad.name, max: ASSET_ATTACHMENT_MAX_MB })
          : tdocs("invalidType", { name: bad.name }),
      );
    }
    if (accepted[0]) setPhoto(accepted[0]);
  }

  function raiseLine(line: PurchaseOrderLine, to: number) {
    updateLine.mutate(
      { id: purchase.id, lineId: line.id, data: { quantity: to } },
      {
        onSuccess: () => toast.success(tl("raisedToast", { quantity: to })),
        onError: (error) => notifyError(error, tl("raiseError")),
      },
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Rendered in a portal; React events still bubble to whatever form opened the sheet (the #164 class).
    event.stopPropagation();
    const plan = buildDeliveryPlan({ purchase, lines, rows, shared, today: localToday(), locale });
    if (!plan.ok) {
      setErrors(plan.errors);
      setEmptyError(plan.empty);
      return;
    }
    setErrors({});
    setScanningId(null);
    setProgress({ current: 0, total: plan.steps.length });

    // The photo first: it is the delivery's evidence, and a failed upload never stops the units.
    let note: NoteOutcome = null;
    if (photo) {
      try {
        await upload.mutateAsync({ file: photo, label: t("deliveryNoteLabel") });
        note = "uploaded";
      } catch {
        note = "failed";
      }
    }

    const outcomes: DeliveryOutcome[] = [];
    for (const [index, step] of plan.steps.entries()) {
      setProgress({ current: index + 1, total: plan.steps.length });
      const lineId = step.line.id;
      try {
        if (step.kind === "ASSET") {
          // Not a dead end: the model picked here is saved on the line (logged), then the units follow it.
          if (step.saveModelId) {
            await updateLine.mutateAsync({ id: purchase.id, lineId, data: { assetModelId: step.saveModelId } });
          }
          const received = await receiveLine.mutateAsync({ id: purchase.id, lineId, data: step.payload });
          outcomes.push(assetOutcome(lineId, received));
        } else {
          if (step.saveConsumableId) {
            await updateLine.mutateAsync({ id: purchase.id, lineId, data: { consumableId: step.saveConsumableId } });
          }
          const received = await receiveStock.mutateAsync({ id: purchase.id, lineId, data: step.payload });
          outcomes.push({
            lineId,
            kind: "CONSUMABLE",
            state: "received",
            created: received.movement.quantity,
            overReceived: received.overReceived,
          });
        }
      } catch (error) {
        outcomes.push({ lineId, kind: step.kind, state: "error", message: messageOf(error, t("lineError")) });
      }
    }
    setProgress(null);
    setResult({ outcomes, note });
    const summary = summarizeDelivery(outcomes);
    if (summary.linesWithProblems === 0 && note !== "failed") {
      toast.success(t("receivedToast", { count: summary.units }));
    }
  }

  const description = t("description", { purchase: titleOf(purchase) });

  if (result) {
    return (
      <DeliveryResult
        purchase={purchase}
        lines={lines}
        outcomes={result.outcomes}
        note={result.note}
        description={description}
        onDone={onClose}
      />
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex min-h-full flex-col">
      <SheetHeader className="px-5 pt-5 pr-12 pb-3">
        <SheetTitle className="text-lg">{t("title")}</SheetTitle>
        <SheetDescription>{description}</SheetDescription>
      </SheetHeader>

      <div className="flex-1 space-y-5 px-5 pb-4">
        {lines.length === 0 ? (
          <Callout tone="info" icon={<CheckCircleIcon />}>
            <p className="text-sm">{t("nothingToReceive")}</p>
          </Callout>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label={t("linesLabel")}>
            {lines.map((line) => {
              const row = rows[line.id];
              if (!row) return null;
              return (
                <DeliveryLineRow
                  key={line.id}
                  line={line}
                  row={row}
                  error={errors[line.id]}
                  scanning={scanningId === line.id}
                  disabled={busy}
                  raising={updateLine.isPending}
                  onChange={(update) => patchRow(line.id, update)}
                  onScan={(open) => setScanningId(open ? line.id : null)}
                  onRaise={(to) => raiseLine(line, to)}
                />
              );
            })}
          </ul>
        )}
        {emptyError ? (
          <p className="text-sm text-destructive" role="alert">
            {t("nothingCounted")}
          </p>
        ) : null}

        {hasAssetRows ? (
          <fieldset className="space-y-3 rounded-lg border p-3" disabled={busy}>
            <legend className="px-1 text-sm font-medium">{t("sharedTitle")}</legend>
            <p className="text-xs text-muted-foreground">{t("sharedHelp")}</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="delivery-purchase-date">{ta("purchaseDate")}</FieldLabel>
                <Input
                  id="delivery-purchase-date"
                  type="date"
                  value={shared.purchaseDate}
                  onChange={(event) => setShared((prev) => ({ ...prev, purchaseDate: event.target.value }))}
                />
                <FieldDescription>
                  {tl(initial.dateSource === "INVOICE" ? "dateFromInvoice" : "dateToday")}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="delivery-status">{ta("status")}</FieldLabel>
                <AssetStatusSelect
                  id="delivery-status"
                  value={{ status: shared.status, labelId: shared.statusLabelId || null }}
                  onChange={(choice) => {
                    if (choice) {
                      setShared((prev) => ({ ...prev, status: choice.status, statusLabelId: choice.labelId ?? "" }));
                    }
                  }}
                  groups={statusGroups}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="delivery-location">{ta("location")}</FieldLabel>
                <LocationCombobox
                  id="delivery-location"
                  value={shared.locationId}
                  onValueChange={(locationId) => setShared((prev) => ({ ...prev, locationId }))}
                  placeholder={ta("locationPlaceholder")}
                  searchPlaceholder={ta("searchLocation")}
                  emptyText={ta("noLocations")}
                />
                <FieldDescription>
                  {purchase.deliveryLocationId ? t("locationFromPurchase") : t("noLocation")}
                </FieldDescription>
              </Field>
            </div>
          </fieldset>
        ) : null}

        <Field>
          <FieldLabel htmlFor="delivery-note-photo">{t("deliveryNote")}</FieldLabel>
          <input
            ref={photoInputRef}
            id="delivery-note-photo"
            type="file"
            accept={DELIVERY_NOTE_ACCEPT}
            className="sr-only"
            onChange={pickPhoto}
            disabled={busy}
          />
          {photo ? (
            <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <CameraIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{photo.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("removePhoto", { name: photo.name })}
                onClick={() => setPhoto(null)}
                disabled={busy}
              >
                <XMarkIcon />
              </Button>
            </div>
          ) : (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => photoInputRef.current?.click()}
                disabled={busy}
              >
                <CameraIcon />
                {t("takePhoto")}
              </Button>
            </div>
          )}
          <FieldDescription>{t("deliveryNoteHelp", { label: t("deliveryNoteLabel") })}</FieldDescription>
        </Field>
      </div>

      <SheetFooter className="sticky bottom-0 flex-row items-center justify-end gap-2 border-t bg-popover px-5 py-3">
        {progress ? (
          <p className="mr-auto text-xs text-muted-foreground" role="status" aria-live="polite">
            {t("progress", progress)}
          </p>
        ) : null}
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {tc("cancel")}
        </Button>
        <Button type="submit" disabled={busy || lines.length === 0}>
          {busy ? <ArrowPathIcon className="animate-spin" /> : null}
          {t("submit", { count: units })}
        </Button>
      </SheetFooter>
    </form>
  );
}

/**
 * One line of the delivery: what it is and what is pending, the count (a stepper starting at 0), and — on an
 * asset row counting at least one unit — the serials box with *Scan*, which opens the camera under this row and
 * fills THIS line (on a phone, the line you are on). An unmapped line asks for its model or consumable inline.
 */
function DeliveryLineRow({
  line,
  row,
  error,
  scanning,
  disabled,
  raising,
  onChange,
  onScan,
  onRaise,
}: {
  line: PurchaseOrderLine;
  row: DeliveryRow;
  error: DeliveryRowError | undefined;
  scanning: boolean;
  disabled: boolean;
  raising: boolean;
  onChange: (update: (row: DeliveryRow) => DeliveryRow) => void;
  onScan: (open: boolean) => void;
  onRaise: (to: number) => void;
}) {
  const t = useTranslations("purchases.receiveDelivery");
  const ta = useTranslations("assets.receive");
  const tl = useTranslations("assets.receive.line");
  const ts = useTranslations("purchases.receiveStock");
  const tr = useTranslations("purchases.receipt");
  const canCreateModel = useCan("assetModel:write");
  const canReadConsumables = useCan("consumable:read");
  const kind = line.kind as DeliveryKind;
  const quantity = rowQuantity(row);
  const serialCount = parseSerials(row.serials).length;
  const over = quantity > 0 ? overReceipt(line, quantity) : null;
  const baseId = `delivery-${line.id}`;
  // Closing the scanner gives focus back to this row's *Scan*.
  const scanButtonRef = useRef<HTMLButtonElement>(null);
  const refocusScanRef = useRef(false);
  useEffect(() => {
    if (!scanning && refocusScanRef.current) {
      refocusScanRef.current = false;
      scanButtonRef.current?.focus();
    }
  }, [scanning]);
  // Stepping the row back to 0 hides its serials box, and the camera with it.
  useEffect(() => {
    if (scanning && quantity === 0) onScan(false);
  }, [scanning, quantity, onScan]);

  const modelPicker = (
    <AssetModelCombobox
      id={`${baseId}-model`}
      value={row.modelId}
      onValueChange={(modelId) => onChange((prev) => ({ ...prev, modelId }))}
      ariaInvalid={error === "modelRequired"}
      placeholder={ta("modelPlaceholder")}
      searchPlaceholder={ta("searchModel")}
      emptyText={ta("noModels")}
    />
  );

  return (
    <li className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium" id={`${baseId}-name`}>
            {line.description}
          </p>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">
              {tr("progress", { received: line.receivedQuantity, ordered: line.quantity })}
            </span>
            {" · "}
            {tr("pending", { count: line.pendingQuantity })}
            {kind === "CONSUMABLE" ? (
              <>
                {" · "}
                <Badge variant="outline" className="align-middle">
                  {t("intoStock")}
                </Badge>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-labelledby={`${baseId}-name`}>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t("decrease", { line: line.description })}
            onClick={() => onChange((prev) => stepRow(prev, kind, -1))}
            disabled={disabled || quantity === 0 || serialCount > 0}
          >
            <MinusIcon />
          </Button>
          <Input
            id={`${baseId}-quantity`}
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            aria-label={t("quantityLabel", { line: line.description })}
            className="w-16 text-center font-mono tabular-nums"
            value={String(quantity)}
            onChange={(event) => onChange((prev) => setRowQuantity(prev, kind, Number(event.target.value)))}
            onFocus={(event) => event.target.select()}
            // With serials the count follows them, so a mismatch can never be sent.
            disabled={disabled || serialCount > 0}
          />
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t("increase", { line: line.description })}
            onClick={() => onChange((prev) => stepRow(prev, kind, 1))}
            disabled={disabled || serialCount > 0}
          >
            <PlusIcon />
          </Button>
        </div>
      </div>

      {kind === "ASSET" && !line.assetModelId ? (
        <Field data-invalid={error === "modelRequired" || undefined}>
          <FieldLabel htmlFor={`${baseId}-model`} required>
            {ta("model")}
          </FieldLabel>
          {canCreateModel ? (
            <CreatableField
              entityKey="model"
              renderDialog={(dialog) => (
                <CreateAssetModelDialog
                  open={dialog.open}
                  onOpenChange={dialog.onOpenChange}
                  defaultName={row.modelId ? undefined : line.description}
                  onCreated={(model) => onChange((prev) => ({ ...prev, modelId: model.id }))}
                />
              )}
            >
              {modelPicker}
            </CreatableField>
          ) : (
            modelPicker
          )}
          <FieldDescription>{tl("modelMissing")}</FieldDescription>
          {error === "modelRequired" ? <FieldError>{ta("modelRequired")}</FieldError> : null}
        </Field>
      ) : null}

      {kind === "CONSUMABLE" && !line.consumableId ? (
        canReadConsumables ? (
          <Field data-invalid={error === "consumableRequired" || undefined}>
            <FieldLabel htmlFor={`${baseId}-consumable`} required>
              {ts("consumable")}
            </FieldLabel>
            <ConsumableCombobox
              id={`${baseId}-consumable`}
              value={row.consumableId}
              onValueChange={(consumableId) => onChange((prev) => ({ ...prev, consumableId }))}
              ariaInvalid={error === "consumableRequired"}
              allowOutOfStock
              placeholder={ts("consumablePlaceholder")}
            />
            <FieldDescription>{ts("consumableMissing")}</FieldDescription>
            {error === "consumableRequired" ? <FieldError>{ts("consumableRequired")}</FieldError> : null}
          </Field>
        ) : (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
            <p className="text-sm">{ts("consumableNoAccess")}</p>
          </Callout>
        )
      ) : null}

      {kind === "ASSET" && quantity > 0 ? (
        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor={`${baseId}-serials`}>{ta("serials")}</FieldLabel>
            {scanning ? null : (
              <Button
                ref={scanButtonRef}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onScan(true)}
                disabled={disabled}
                aria-label={t("scanFor", { line: line.description })}
              >
                <QrCodeIcon />
                {ta("scan")}
              </Button>
            )}
          </div>
          <Textarea
            id={`${baseId}-serials`}
            value={row.serials}
            onChange={(event) => onChange((prev) => setRowSerials(prev, event.target.value))}
            rows={2}
            className="font-mono"
            placeholder={ta("serialsPlaceholder")}
            disabled={disabled}
          />
          {scanning ? (
            <SerialScanner
              existing={parseSerials(row.serials)}
              onScan={(code) => onChange((prev) => addScannedSerial(prev, code))}
              onDone={() => {
                refocusScanRef.current = true;
                onScan(false);
              }}
            />
          ) : null}
          <FieldDescription>{t("serialsHelp")}</FieldDescription>
        </Field>
      ) : null}

      {over?.over ? (
        <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
          <p className="text-sm">
            {tl("overWarning", { ordered: line.quantity - line.cancelledQuantity, after: over.after })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={raising || disabled}
            onClick={() => onRaise(over.raiseTo)}
          >
            {tl("raise", { quantity: over.raiseTo })}
          </Button>
        </Callout>
      ) : null}

      {error === "invalid" ? (
        <p className="text-sm text-destructive" role="alert">
          {t("rowInvalid")}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The combined result: units received across the delivery, then each line — received, partly received (with
 * the units that could not be created and why), or not received (the request failed) — and whether the
 * delivery note was attached. A partial result is a result, not an error (ADR-0089 A2).
 */
function DeliveryResult({
  purchase,
  lines,
  outcomes,
  note,
  description,
  onDone,
}: {
  purchase: PurchaseOrderDetail;
  lines: readonly PurchaseOrderLine[];
  outcomes: readonly DeliveryOutcome[];
  note: NoteOutcome;
  description: string;
  onDone: () => void;
}) {
  const t = useTranslations("purchases.receiveDelivery");
  const ta = useTranslations("assets.receive");
  const summary = summarizeDelivery(outcomes);
  const byId = new Map(lines.map((line) => [line.id, line]));

  return (
    <div className="flex min-h-full flex-col">
      <SheetHeader className="px-5 pt-5 pr-12 pb-3">
        <SheetTitle className="text-lg">{t("title")}</SheetTitle>
        <SheetDescription>{description}</SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 px-5 pb-4">
        {summary.units > 0 ? (
          <Callout tone="success" icon={<CheckCircleIcon />}>
            <p className="text-sm font-medium">{t("result.summary", { units: summary.units })}</p>
            {summary.linesWithProblems > 0 ? (
              <p className="mt-0.5 text-sm">{t("result.someProblems", { count: summary.linesWithProblems })}</p>
            ) : null}
          </Callout>
        ) : (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
            <p className="text-sm font-medium">{t("result.nothingReceived")}</p>
          </Callout>
        )}

        <ul className="divide-y rounded-lg border text-sm">
          {outcomes.map((outcome) => {
            const line = byId.get(outcome.lineId);
            return (
              <li key={outcome.lineId} className="space-y-1 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{line?.description ?? t("result.aLine")}</span>
                  {outcome.state === "received" ? (
                    <span className="inline-flex items-center gap-1">
                      <CheckCircleIcon className="size-4 text-success" aria-hidden />
                      {outcome.kind === "CONSUMABLE"
                        ? t("result.stockReceived", { count: outcome.created })
                        : t("result.unitsReceived", { count: outcome.created })}
                    </span>
                  ) : outcome.state === "partial" ? (
                    <span className="text-warning-text">
                      {t("result.partial", { created: outcome.created, failed: outcome.failed.length })}
                    </span>
                  ) : outcome.state === "failed" ? (
                    <span className="text-warning-text">{t("result.failed")}</span>
                  ) : (
                    <span className="text-destructive">{t("result.notReceived")}</span>
                  )}
                </div>
                {outcome.state === "error" ? (
                  <p className="break-words text-muted-foreground">{outcome.message}</p>
                ) : null}
                {(outcome.state === "partial" || outcome.state === "failed") && outcome.kind === "ASSET" ? (
                  <ul className="space-y-0.5">
                    {outcome.failed.map((item) => (
                      <li key={item.index} className="flex items-baseline gap-2">
                        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                          {ta("result.unit", { index: item.index + 1 })}
                        </span>
                        <span className="break-words">{item.error}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {outcome.state !== "error" && outcome.overReceived ? (
                  <p className="text-muted-foreground">{t("result.overReceived")}</p>
                ) : null}
              </li>
            );
          })}
        </ul>

        {note === "uploaded" ? (
          <p className="text-sm text-muted-foreground">{t("result.noteUploaded")}</p>
        ) : note === "failed" ? (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
            <p className="text-sm">{t("result.noteFailed")}</p>
          </Callout>
        ) : null}
      </div>
      <SheetFooter className="sticky bottom-0 flex-row items-center justify-end gap-2 border-t bg-popover px-5 py-3">
        <OpenPurchaseButton purchaseId={purchase.id}>{t("result.openPurchase")}</OpenPurchaseButton>
        <Button type="button" onClick={onDone}>
          {ta("result.done")}
        </Button>
      </SheetFooter>
    </div>
  );
}
