"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InboxArrowDownIcon,
  QrCodeIcon,
} from "@heroicons/react/24/outline";
import {
  type AssetStatus,
  AssetStatusSchema,
  type PendingPurchaseLine,
  type PurchaseOrderDetail,
  type PurchaseOrderLine,
  type ReceiveAssetsResult,
  ReceiveAssetsSchema,
  RECEIVE_ASSETS_MAX_QUANTITY,
  ReceiveFromLineSchema,
} from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AssetModelCombobox } from "@/components/asset-model-combobox";
import { Callout } from "@/components/callout";
import { CreatableField } from "@/components/creatable-field";
import { CreateAssetModelDialog } from "@/components/create-asset-model-dialog";
import { LocationCombobox } from "@/components/location-combobox";
import { MoneyField } from "@/components/money-input";
import {
  PendingLinePicker,
  PendingLineSuggestion,
  type ReceiveLineTarget,
  useCanReceiveAgainstPurchases,
  useLoadLineTarget,
  useOpenLines,
} from "@/components/purchases/pending-line-picker";
import { SerialScanner } from "@/components/serial-scanner";
import { SuggestInput, useRecentValues } from "@/components/suggest-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useSuggestions } from "@/lib/api/hooks/use-suggestions";
import { useReceiveAssets } from "@/lib/api/hooks/use-asset-receive";
import { useAssetModel } from "@/lib/api/hooks/use-asset-models";
import { useReceiveFromLine, useUpdatePurchaseOrderLine } from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { localToday } from "@/lib/purchases/pending";
import { parseMoneyInput } from "@/lib/utils/money";
import { appendSerial } from "@/lib/utils/scanned-serials";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";
import { usePurchaseTitle } from "../../purchases/_components/purchase-display";
import { useAssetStatusLabel } from "./asset-status-badge";
import {
  buildReceiveFromLinePayload,
  buildReceivePayload,
  effectiveQuantity,
  type LineReceiveFormValues,
  lineReceivePrefill,
  overReceipt,
  parseSerials,
  type ReceiveDateSource,
} from "./receive-stock-payload";

type FieldErrors = Partial<
  Record<"form" | "modelId" | "quantity" | "serials", string>
>;

export type { ReceiveLineTarget };

/** The result of either receive: bulk receive's envelope, plus the line afterwards when against one. */
type ReceiveOutcome = ReceiveAssetsResult & { line?: PurchaseOrderLine };

const EMPTY_FORM: LineReceiveFormValues = {
  modelId: "",
  quantity: "1",
  status: "OPERATIONAL",
  locationId: "",
  company: "",
  purchaseDate: "",
  purchaseCost: "",
  purchaseCurrency: "",
  warrantyEnd: "",
  notes: "",
  serials: "",
};

/**
 * The "Receive stock" button of the Assets list: its trigger plus the dialog, mounted only while open so
 * every opening starts clean. Gate it with `asset:write` at the call site (like the New-asset button).
 */
export function ReceiveStockButton() {
  const t = useTranslations("assets.receive");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <InboxArrowDownIcon />
        {t("button")}
      </Button>
      {open ? <ReceiveStockDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Bulk receiving (ADR-0089 Part A, #1029) — mint N identical assets from ONE AssetModel in a single
 * action ("we just received 20 ThinkPads"). The form fields are the shared context applied to EVERY
 * minted unit; the optional serials paste assigns one serial per unit (empty, or exactly `quantity`
 * lines — enforced by the shared schema before any write).
 *
 * **From a purchase line** (ADR-0099, UX proposal §3.d, #1475): with a `line` — the purchase page's
 * *Receive*, the *Pending units* tab, or the optional *From purchase* picker and model suggestion below —
 * the same dialog receives AGAINST the line through `POST /purchase-orders/:id/lines/:lineId/receive`.
 * Everything is prefilled from the purchase (summarised, with *Change* to edit it), the serials come first
 * and the quantity follows them, and receiving past the pending count is allowed with a warning that
 * offers to raise the line. A line with no model asks for one inline and saves it on the line first.
 * The purchase option needs `purchaseOrder:read` and `:write`; without them none of it renders or loads.
 *
 * Mounted only while open, so the form starts clean on every opening and the nested "create model"
 * dialog (issue #1229) can never wipe what was typed. The "+" for a new model is gated on
 * `assetModel:write`.
 *
 * Both endpoints are PARTIAL-SUCCESS ones (a per-unit create loop): `{ created, failed }`, so a partial
 * (or total) failure is a RESULT view, not an error toast. Money is entered in MAJOR units in the
 * viewer's locale and converted to minor units on submit (#954, #1470).
 */
export function ReceiveStockDialog({
  onClose,
  line: initialLine = null,
}: {
  onClose: () => void;
  line?: ReceiveLineTarget | null;
}) {
  const t = useTranslations("assets.receive");
  const tl = useTranslations("assets.receive.line");
  const tc = useTranslations("common");
  const statusLabel = useAssetStatusLabel();
  const titleOf = usePurchaseTitle();
  const { date } = useFormatters();
  const receive = useReceiveAssets();
  const receiveLine = useReceiveFromLine();
  const updateLine = useUpdatePurchaseOrderLine();
  const locale = useLocale();
  const [, rememberCompany] = useRecentValues("asset.company");
  // Creating a model is its own permission — the "+" only renders when the operator actually has it.
  const canCreateModel = useCan("assetModel:write");
  const canUsePurchases = useCanReceiveAgainstPurchases();

  const [initial] = useState(() =>
    initialLine ? lineReceivePrefill(initialLine.purchase, initialLine.line, localToday(), locale) : null,
  );
  const [target, setTarget] = useState<ReceiveLineTarget | null>(initialLine);
  const [dateSource, setDateSource] = useState<ReceiveDateSource | null>(initial?.dateSource ?? null);
  // Local state — the mixed serials-text→array + major→minor-money coercion makes a plain controlled
  // form simpler than RHF here; the shared schemas are the real validators on submit.
  const [values, setValues] = useState<LineReceiveFormValues>(initial?.values ?? EMPTY_FORM);
  const [editPrefill, setEditPrefill] = useState(false);
  // The camera scanner under the serials box (#1476), open on demand.
  const [scanning, setScanning] = useState(false);
  // Closing the scanner gives focus back to *Scan* (the scanner itself focuses its *Done* on opening).
  const scanButtonRef = useRef<HTMLButtonElement>(null);
  const refocusScanRef = useRef(false);
  useEffect(() => {
    if (!scanning && refocusScanRef.current) {
      refocusScanRef.current = false;
      scanButtonRef.current?.focus();
    }
  }, [scanning]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const lineLoader = useLoadLineTarget();
  const switching = lineLoader.loading;
  // Company values already in use, with counts and last use (ADR-0099 §7).
  const companies = useSuggestions("company", values.company);
  // Open purchase lines, for the "From purchase" picker and the model suggestion — plain mode only.
  const openLines = useOpenLines(canUsePurchases && target === null);
  // The last NON-EMPTY term typed in the model picker, to seed the inline create dialog (#1229).
  const [modelSearch, setModelSearch] = useState("");
  const [result, setResult] = useState<ReceiveOutcome | null>(null);
  // The model's name for the purchase-mode summary.
  const { data: chosenModel, isLoading: modelLoading } = useAssetModel(
    target && values.modelId ? values.modelId : undefined,
  );

  function patch(next: Partial<LineReceiveFormValues>) {
    setValues((prev) => ({ ...prev, ...next }));
  }

  /**
   * One scanned serial (#1476), appended on its own line. Against a line the quantity already follows the
   * serials; in plain mode it is set to their count, so a scanned delivery never trips the "serials must
   * match the quantity" rule.
   */
  function addScannedSerial(code: string) {
    setValues((prev) => {
      const serials = appendSerial(prev.serials, code);
      return target ? { ...prev, serials } : { ...prev, serials, quantity: String(parseSerials(serials).length) };
    });
    setErrors((prev) => ({ ...prev, serials: undefined, quantity: undefined }));
  }

  function startLine(next: ReceiveLineTarget) {
    const prefill = lineReceivePrefill(next.purchase, next.line, localToday(), locale);
    setTarget(next);
    setValues(prefill.values);
    setDateSource(prefill.dateSource);
    setEditPrefill(false);
    setErrors({});
    setResult(null);
  }

  /** "From purchase": the open line's purchase header is needed for the prefill, so read it first. */
  async function pickOpenLine(pending: PendingPurchaseLine) {
    const next = await lineLoader.load(pending);
    if (next) startLine(next);
  }

  function receiveMore() {
    if (target) {
      // The line as it reads after the receive, so "pending" is right for the next delivery.
      startLine({ purchase: target.purchase, line: result?.line ?? target.line });
      return;
    }
    setValues(EMPTY_FORM);
    setModelSearch("");
    setErrors({});
    setResult(null);
  }

  const lineMissingModel = target !== null && target.line.assetModelId === null;
  const quantity = effectiveQuantity(values.quantity, values.serials);
  const serialsCount = parseSerials(values.serials).length;
  const over = target ? overReceipt(target.line, quantity) : null;

  /** Raise the line's quantity (logged on the purchase) so the receive is exact again (ADR-0099 §4). */
  function raiseLine(line: PurchaseOrderLine, to: number) {
    if (!target) return;
    updateLine.mutate(
      { id: target.purchase.id, lineId: line.id, data: { quantity: to } },
      {
        onSuccess: (updated) => {
          toast.success(tl("raisedToast", { quantity: to }));
          setTarget({ purchase: target.purchase, line: updated });
          setResult((prev) => (prev ? { ...prev, line: updated, overReceived: false } : prev));
        },
        onError: (error) => notifyError(error, tl("raiseError")),
      },
    );
  }

  function validationErrors(issues: readonly { path: PropertyKey[] }[]): FieldErrors {
    const next: FieldErrors = {};
    for (const issue of issues) {
      const key = issue.path[0];
      if (key === "modelId") next.modelId = t("modelRequired");
      else if (key === "quantity") next.quantity = t("quantityInvalid", { max: RECEIVE_ASSETS_MAX_QUANTITY });
      else if (key === "serials")
        next.serials = t("serialsCountMismatch", { quantity: values.quantity || "0" });
    }
    // A failure on a field not rendered inline (company/notes/cost/…) → a form-level notice rather than
    // mis-blaming the model field.
    if (Object.keys(next).length === 0) next.form = t("validationError");
    return next;
  }

  function onReceived(envelope: ReceiveOutcome) {
    if (envelope.created.length > 0) rememberCompany(values.company);
    setResult(envelope);
    if (envelope.failed.length === 0) {
      toast.success(t("createdToast", { count: envelope.created.length }));
    }
  }

  async function submitLine(current: ReceiveLineTarget) {
    if (lineMissingModel && !values.modelId) {
      setErrors({ modelId: t("modelRequired") });
      return;
    }
    const parsed = ReceiveFromLineSchema.safeParse(
      buildReceiveFromLinePayload(values, locale, { locationId: current.purchase.deliveryLocationId ?? "" }),
    );
    if (!parsed.success) {
      setErrors(validationErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    let line = current.line;
    if (lineMissingModel) {
      // Not a dead end: the model chosen here is saved on the line (logged), then the units follow it.
      try {
        line = await updateLine.mutateAsync({
          id: current.purchase.id,
          lineId: line.id,
          data: { assetModelId: values.modelId },
        });
        setTarget({ purchase: current.purchase, line });
      } catch (error) {
        notifyError(error, tl("modelSaveError"));
        return;
      }
    }
    receiveLine.mutate(
      { id: current.purchase.id, lineId: line.id, data: parsed.data },
      { onSuccess: onReceived, onError: (error) => notifyError(error, t("submitError")) },
    );
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // The dialog renders in a Portal, but React events bubble through portals: opened from the New asset
    // form, its submit would otherwise also submit that form (the issue #164 class).
    event.stopPropagation();
    // A refused amount already shows its reason inline on the field (#1470): stop there.
    if (!parseMoneyInput(values.purchaseCost, locale).ok) {
      scrollToFirstError(event.target);
      return;
    }
    if (target) {
      void submitLine(target);
      return;
    }
    // The form→wire mapping lives in the pure `buildReceivePayload`; the shared schema stays the single
    // validator: quantity bounds, the serials-count refinement, and the field shapes.
    const parsed = ReceiveAssetsSchema.safeParse(buildReceivePayload(values, locale));
    if (!parsed.success) {
      setErrors(validationErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    receive.mutate(parsed.data, {
      onSuccess: onReceived,
      onError: (error) => notifyError(error, t("submitError")),
    });
  }

  const pending = receive.isPending || receiveLine.isPending || (updateLine.isPending && !result);

  // The picker itself — rendered bare, or wrapped in the "+ New" affordance when the operator may
  // create models. Declared once so both arms stay identical.
  const modelPicker = (
    <AssetModelCombobox
      id="receive-model"
      value={values.modelId}
      onValueChange={(value) => patch({ modelId: value })}
      onSearchChange={(query) => {
        const term = query.trim();
        if (term) setModelSearch(term);
      }}
      ariaInvalid={Boolean(errors.modelId)}
      placeholder={t("modelPlaceholder")}
      searchPlaceholder={t("searchModel")}
      emptyText={t("noModels")}
    />
  );

  const modelField = (
    <Field data-invalid={errors.modelId ? true : undefined}>
      <FieldLabel htmlFor="receive-model" required>
        {t("model")}
      </FieldLabel>
      {canCreateModel ? (
        <CreatableField
          entityKey="model"
          renderDialog={(dialog) => (
            <CreateAssetModelDialog
              open={dialog.open}
              onOpenChange={dialog.onOpenChange}
              // Seed the name with the fruitless search (or, on a line, its description), but only when no
              // model is picked yet — otherwise an old term would leak into an unrelated create.
              defaultName={values.modelId ? undefined : modelSearch || target?.line.description}
              onCreated={(model) => {
                patch({ modelId: model.id });
                setErrors((prev) => ({ ...prev, modelId: undefined }));
              }}
            />
          )}
        >
          {modelPicker}
        </CreatableField>
      ) : (
        modelPicker
      )}
      <FieldDescription>{lineMissingModel ? tl("modelMissing") : t("modelHelp")}</FieldDescription>
      {errors.modelId ? <FieldError errors={[{ message: errors.modelId }]} /> : null}
    </Field>
  );

  const quantityField = (
    <Field data-invalid={errors.quantity ? true : undefined}>
      <FieldLabel htmlFor="receive-quantity" required>
        {t("quantity")}
      </FieldLabel>
      <Input
        id="receive-quantity"
        type="number"
        inputMode="numeric"
        min="1"
        max={RECEIVE_ASSETS_MAX_QUANTITY}
        step="1"
        // In line mode the quantity follows the pasted serials, so a mismatch can never be sent.
        value={target && serialsCount > 0 ? String(serialsCount) : values.quantity}
        disabled={target !== null && serialsCount > 0}
        onChange={(e) => patch({ quantity: e.target.value })}
        aria-invalid={Boolean(errors.quantity) || undefined}
      />
      <FieldDescription>
        {target
          ? tl("quantityHelp", { pending: target.line.pendingQuantity })
          : t("quantityHelp", { max: RECEIVE_ASSETS_MAX_QUANTITY })}
      </FieldDescription>
      {errors.quantity ? <FieldError errors={[{ message: errors.quantity }]} /> : null}
    </Field>
  );

  const serialsField = (
    <Field data-invalid={errors.serials ? true : undefined}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor="receive-serials">{t("serials")}</FieldLabel>
        {scanning ? null : (
          <Button ref={scanButtonRef} type="button" variant="outline" size="sm" onClick={() => setScanning(true)}>
            <QrCodeIcon />
            {t("scan")}
          </Button>
        )}
      </div>
      <Textarea
        id="receive-serials"
        value={values.serials}
        onChange={(e) => patch({ serials: e.target.value })}
        rows={3}
        className="font-mono"
        placeholder={t("serialsPlaceholder")}
        aria-invalid={Boolean(errors.serials) || undefined}
        autoFocus={target !== null}
      />
      {scanning ? (
        <SerialScanner
          existing={parseSerials(values.serials)}
          onScan={addScannedSerial}
          onDone={() => {
            refocusScanRef.current = true;
            setScanning(false);
          }}
        />
      ) : null}
      <FieldDescription>{target ? tl("serialsHelp") : t("serialsHelp")}</FieldDescription>
      {errors.serials ? <FieldError errors={[{ message: errors.serials }]} /> : null}
    </Field>
  );

  const sharedFields = (
    <div className="grid gap-4 sm:grid-cols-2">
      {target ? null : quantityField}
      <Field>
        <FieldLabel htmlFor="receive-status">{t("status")}</FieldLabel>
        <Select value={values.status} onValueChange={(value) => patch({ status: value as AssetStatus })}>
          <SelectTrigger id="receive-status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AssetStatusSchema.options.map((option) => (
              <SelectItem key={option} value={option}>
                {statusLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="receive-location">{t("location")}</FieldLabel>
        <LocationCombobox
          id="receive-location"
          value={values.locationId}
          onValueChange={(value) => patch({ locationId: value })}
          placeholder={t("locationPlaceholder")}
          searchPlaceholder={t("searchLocation")}
          emptyText={t("noLocations")}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="receive-company">{t("company")}</FieldLabel>
        <SuggestInput
          id="receive-company"
          value={values.company}
          onValueChange={(company) => patch({ company })}
          source={() => companies}
          recentKey="asset.company"
          placeholder={t("companyPlaceholder")}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="receive-purchase-date">{t("purchaseDate")}</FieldLabel>
        <Input
          id="receive-purchase-date"
          type="date"
          value={values.purchaseDate}
          onChange={(e) => patch({ purchaseDate: e.target.value })}
        />
        {target && dateSource ? (
          <FieldDescription>{tl(dateSource === "INVOICE" ? "dateFromInvoice" : "dateToday")}</FieldDescription>
        ) : null}
      </Field>
      <MoneyField
        id="receive-cost"
        label={
          target && values.purchaseCurrency
            ? tl("costWithCurrency", { currency: values.purchaseCurrency })
            : t("purchaseCost")
        }
        description={t("purchaseCostHelp")}
        value={values.purchaseCost}
        onValueChange={(purchaseCost) => patch({ purchaseCost })}
        placeholder={t("purchaseCostPlaceholder")}
      />
      {target ? (
        <Field>
          <FieldLabel htmlFor="receive-warranty-end">{tl("warrantyEnd")}</FieldLabel>
          <Input
            id="receive-warranty-end"
            type="date"
            value={values.warrantyEnd}
            onChange={(e) => patch({ warrantyEnd: e.target.value })}
          />
        </Field>
      ) : null}
    </div>
  );

  const notesField = (
    <Field>
      <FieldLabel htmlFor="receive-notes">{t("notes")}</FieldLabel>
      <Textarea
        id="receive-notes"
        value={values.notes}
        onChange={(e) => patch({ notes: e.target.value })}
        rows={2}
        placeholder={t("notesPlaceholder")}
      />
    </Field>
  );

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target ? tl("title") : t("title")}</DialogTitle>
          <DialogDescription>
            {target
              ? tl("description", {
                  purchase: titleOf(target.purchase),
                  line: target.line.description,
                  pending: target.line.pendingQuantity,
                })
              : t("description")}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <ReceiveResult
            result={result}
            modelId={values.modelId}
            target={target}
            raising={updateLine.isPending}
            onRaise={raiseLine}
            onReceiveMore={receiveMore}
            onDone={onClose}
          />
        ) : (
          <>
            <form
              id="receive-stock-form"
              onSubmit={handleSubmit}
              noValidate
              className="min-h-0 flex-1 overflow-y-auto pr-1"
            >
              <FieldGroup>
                {errors.form ? (
                  <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
                    <p className="text-sm">{errors.form}</p>
                  </Callout>
                ) : null}

                {target ? (
                  <>
                    {serialsField}
                    {quantityField}
                    {over?.over ? (
                      <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
                        <p className="text-sm">
                          {tl("overWarning", {
                            ordered: target.line.quantity - target.line.cancelledQuantity,
                            after: over.after,
                          })}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          disabled={updateLine.isPending}
                          onClick={() => raiseLine(target.line, over.raiseTo)}
                        >
                          {tl("raise", { quantity: over.raiseTo })}
                        </Button>
                      </Callout>
                    ) : null}
                    {lineMissingModel ? modelField : null}
                    {editPrefill ? (
                      <>
                        {lineMissingModel ? null : modelField}
                        {sharedFields}
                      </>
                    ) : (
                      prefillSummary(target.purchase)
                    )}
                    {notesField}
                  </>
                ) : (
                  <>
                    {canUsePurchases ? (
                      <Field>
                        <FieldLabel htmlFor="receive-from-purchase">{tl("fromPurchase")}</FieldLabel>
                        <PendingLinePicker
                          id="receive-from-purchase"
                          lines={openLines.data?.items ?? []}
                          loading={openLines.isLoading || switching}
                          onPick={(line) => void pickOpenLine(line)}
                        />
                        <FieldDescription>{tl("fromPurchaseHelp")}</FieldDescription>
                      </Field>
                    ) : null}
                    {modelField}
                    {canUsePurchases ? (
                      <PendingLineSuggestion
                        modelId={values.modelId}
                        lines={openLines.data?.items ?? []}
                        onPick={(line) => void pickOpenLine(line)}
                      />
                    ) : null}
                    {sharedFields}
                    {notesField}
                    {serialsField}
                  </>
                )}
              </FieldGroup>
            </form>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                {tc("cancel")}
              </Button>
              <Button type="submit" form="receive-stock-form" disabled={pending || switching}>
                {pending && <ArrowPathIcon className="animate-spin" />}
                {target ? tl("submit", { count: Number.isFinite(quantity) ? quantity : 0 }) : t("submit")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );

  /** The prefilled values at a glance; *Change* opens them as fields (each override is this receive's only). */
  function prefillSummary(purchase: PurchaseOrderDetail) {
    const shown = values;
    const source = dateSource;
    const none = <span className="text-muted-foreground">—</span>;
    const cost = shown.purchaseCost.trim();
    const rows: { label: string; value: React.ReactNode }[] = [
      {
        label: t("model"),
        value: chosenModel ? `${chosenModel.manufacturer} ${chosenModel.name}` : modelLoading ? "…" : none,
      },
      { label: t("status"), value: statusLabel(shown.status) },
      { label: t("company"), value: shown.company || none },
      {
        label: t("purchaseDate"),
        value: shown.purchaseDate ? (
          <>
            <span className="font-mono">{date(`${shown.purchaseDate}T00:00:00.000Z`)}</span>
            {source ? (
              <span className="text-muted-foreground">
                {" · "}
                {tl(source === "INVOICE" ? "dateFromInvoiceShort" : "dateTodayShort")}
              </span>
            ) : null}
          </>
        ) : (
          none
        ),
      },
      {
        label: tl("costEach"),
        value: cost ? (
          <span className="font-mono">{[shown.purchaseCurrency, cost].filter(Boolean).join(" ")}</span>
        ) : (
          none
        ),
      },
      {
        label: tl("warrantyEnd"),
        value: shown.warrantyEnd ? <span className="font-mono">{date(`${shown.warrantyEnd}T00:00:00.000Z`)}</span> : none,
      },
    ];
    return (
      <div className="rounded-md border p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{tl("fromThePurchase")}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditPrefill(true)}>
            {tl("change")}
          </Button>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-3 sm:block">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          {purchase.deliveryLocationId ? tl("locationFromPurchase") : tl("noLocation")}
        </p>
      </div>
    );
  }
}

/**
 * The partial-success RESULT view (ADR-0089 A2). `created.length` assets landed; `failed` lists the
 * per-unit failures by 0-based batch index with a reason. A total failure (`created.length === 0`) is
 * still a valid 201 — surfaced as an informational notice, never an error. Against a line, an
 * over-received line is a warning with the one-click "raise the line" (ADR-0099 §4).
 */
function ReceiveResult({
  result,
  modelId,
  target,
  raising,
  onRaise,
  onReceiveMore,
  onDone,
}: {
  result: ReceiveOutcome;
  modelId: string;
  target: ReceiveLineTarget | null;
  raising: boolean;
  onRaise: (line: PurchaseOrderLine, to: number) => void;
  onReceiveMore: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("assets.receive");
  const tl = useTranslations("assets.receive.line");
  const created = result.created.length;
  const failed = result.failed;
  const line = result.line;
  const expected = line ? line.quantity - line.cancelledQuantity : 0;

  // Flex column inside the (now flex, overflow-hidden) DialogContent: the summary + failure list
  // scroll, the footer stays pinned — same contract the form body gets.
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {created > 0 ? (
          <Callout tone="success" icon={<CheckCircleIcon />}>
            <p className="text-sm font-medium">
              {t("result.createdSummary", { count: created })}
            </p>
            {failed.length > 0 ? (
              <p className="mt-0.5 text-sm">
                {t("result.someFailed", {
                  failed: failed.length,
                  total: created + failed.length,
                })}
              </p>
            ) : null}
          </Callout>
        ) : (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
            <p className="text-sm font-medium">{t("result.allFailed")}</p>
          </Callout>
        )}

        {result.overReceived && line ? (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
            <p className="text-sm">
              {tl("overResult", { received: line.receivedQuantity, ordered: expected })}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={raising}
              onClick={() => onRaise(line, line.receivedQuantity + line.cancelledQuantity)}
            >
              {tl("raise", { quantity: line.receivedQuantity + line.cancelledQuantity })}
            </Button>
          </Callout>
        ) : null}

        {failed.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t("result.failedTitle")}
            </p>
            <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border text-sm">
              {failed.map((item) => (
                <li
                  key={item.index}
                  className="flex items-baseline gap-2 px-3 py-2"
                >
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {t("result.unit", { index: item.index + 1 })}
                  </span>
                  <span className="break-words">{item.error}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <DialogFooter>
        {created > 0 ? (
          <Button variant="outline" asChild>
            <Link href={modelId ? `/assets?model=${modelId}` : "/assets"}>
              {t("result.viewInventory")}
            </Link>
          </Button>
        ) : null}
        {target ? (
          <Button variant="outline" asChild>
            <Link href={`/purchases/${target.purchase.id}`}>{tl("openPurchase")}</Link>
          </Button>
        ) : null}
        <Button variant="outline" onClick={onReceiveMore}>
          {t("result.receiveMore")}
        </Button>
        <Button onClick={onDone}>{t("result.done")}</Button>
      </DialogFooter>
    </div>
  );
}
