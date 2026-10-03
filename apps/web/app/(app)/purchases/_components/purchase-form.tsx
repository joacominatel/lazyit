"use client";

import { ArrowPathIcon, ChevronDownIcon, PlusIcon } from "@heroicons/react/24/outline";
import {
  CreatePurchaseOrderSchema,
  groupMoneyTotals,
  type PurchaseOrderDetail,
  type PurchaseOrderStatus,
  UpdatePurchaseOrderSchema,
} from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { LocationCombobox } from "@/components/location-combobox";
import { SuggestInput, useRecentValues } from "@/components/suggest-input";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreatePurchaseOrder,
  usePurchaseOrders,
  useUpdatePurchaseOrder,
} from "@/lib/api/hooks/use-purchase-orders";
import { useSuggestions } from "@/lib/api/hooks/use-suggestions";
import { useCreateSupplier } from "@/lib/api/hooks/use-suppliers";
import { notifyError } from "@/lib/api/notify-error";
import { useBeforeUnloadGuard } from "@/lib/hooks/use-before-unload-guard";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  emptyHeaderDraft,
  emptyLineDraft,
  headerDraftFrom,
  isBlankLine,
  type LineDraft,
  type LineErrors,
  type PurchaseHeaderDraft,
  toCreatePurchase,
  toUpdatePurchase,
} from "@/lib/purchases/payload";
import { referenceDuplicate } from "@/lib/purchases/reference";
import { isSaveShortcut, isUnfocusedTarget } from "@/lib/purchases/save-shortcut";
import { runExclusive } from "@/lib/purchases/submit-guard";
import { resolveSupplier } from "@/lib/purchases/supplier";
import { formatMoney, parseMoneyInput } from "@/lib/utils/money";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";
import type { SuggestCandidate } from "@/lib/utils/suggest";
import { LineFields } from "./line-fields";
import { SegmentedChoice } from "./segmented-choice";
import { usePurchaseTitle } from "./purchase-display";
import { findSuppliersNamed, SupplierField, useSupplierResolution } from "./supplier-field";

const FORM_ID = "purchase-form";

/** The candidate used most recently instance-wide — the currency default when this viewer has none. */
function latestUsed(candidates: readonly SuggestCandidate[] | undefined): string {
  let best: SuggestCandidate | undefined;
  for (const c of candidates ?? []) {
    if (!best || new Date(c.lastUsedAt ?? 0).getTime() > new Date(best.lastUsedAt ?? 0).getTime()) {
      best = c;
    }
  }
  return best?.value ?? "";
}

/** Header fields that live behind "More details" — opened by default when an edited purchase has one. */
const MORE_FIELDS = [
  "expectedDate",
  "deliveryLocationId",
  "company",
  "invoiceNumbers",
  "invoiceDate",
  "notes",
] as const satisfies readonly (keyof PurchaseHeaderDraft)[];

/**
 * Create a purchase, or edit its header (ADR-0099, UX proposal §3.a) — built for speed: one page, the
 * identifying fields first, the rest behind *More details*, and (on create) an inline line editor driven
 * from the keyboard: Enter in a line adds the next one, Ctrl/Cmd+Enter saves. Nothing is required beyond
 * what identifies the purchase — a supplier, a reference or one line (CEO decision D-D).
 *
 * The supplier is typed by name and resolved on save (an existing supplier is linked, a new name is
 * created inline). The currency label starts at the viewer's last used one. Lines of a saved purchase are
 * edited on its detail page, through their own endpoints.
 */
export function PurchaseForm({ purchase }: { purchase?: PurchaseOrderDetail }) {
  const t = useTranslations("purchases.form");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const isEdit = purchase != null;
  const createPurchase = useCreatePurchaseOrder();
  const updatePurchase = useUpdatePurchaseOrder();
  const createSupplier = useCreateSupplier();
  const [saving, setSaving] = useState(false);
  // A save is several requests; the ref (not the state, which lags a render) keeps it to one at a time.
  const submitting = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const titleOf = usePurchaseTitle();

  const [header, setHeader] = useState<PurchaseHeaderDraft>(() =>
    purchase ? headerDraftFrom(purchase) : emptyHeaderDraft(),
  );
  const [supplierText, setSupplierText] = useState(purchase?.supplier?.name ?? "");
  const [supplierChoice, setSupplierChoice] = useState("");
  const [supplierError, setSupplierError] = useState<string>();
  const savedSupplier = purchase?.supplier;
  const currentSupplier = useMemo(
    () => (savedSupplier ? { id: savedSupplier.id, name: savedSupplier.name } : null),
    [savedSupplier],
  );
  const { resolution: supplierResolution, sameNamed } = useSupplierResolution(
    supplierText,
    currentSupplier,
    supplierChoice,
  );

  // The currency label defaults to the last one used (this viewer's, else the instance's) until typed.
  const [recentCurrencies, rememberCurrency] = useRecentValues("currency");
  const [currencyTouched, setCurrencyTouched] = useState(isEdit);
  const currencies = useSuggestions("currency", currencyTouched ? header.currency : "");
  const currency = currencyTouched
    ? header.currency
    : (recentCurrencies[0] ?? latestUsed(currencies));
  const companies = useSuggestions("company", header.company);
  const [, rememberCompany] = useRecentValues("asset.company");
  const [, rememberSupplier] = useRecentValues("purchase.supplier");
  const [, rememberManufacturer] = useRecentValues("assetModel.manufacturer");
  const [, rememberLineModel] = useRecentValues("purchase.lineModel");
  const [, rememberReference] = useRecentValues("purchase.reference");
  const [, rememberInvoiceNumbers] = useRecentValues("purchase.invoiceNumbers");
  const [, rememberLineDescription] = useRecentValues("purchase.lineDescription");
  // Smart entry for the purchase's own text (ADR-0099 §7, #1473): references and invoice numbers already used.
  const references = useSuggestions("reference", header.reference);
  const invoiceNumbers = useSuggestions("invoiceNumbers", header.invoiceNumbers);

  const [moreOpen, setMoreOpen] = useState(
    () => purchase != null && MORE_FIELDS.some((field) => headerDraftFrom(purchase)[field] !== ""),
  );
  // A purchase of the same supplier already carrying this reference (ADR-0099 §6): a hint, never a refusal.
  const referenceQuery = useDebouncedValue(header.reference.trim(), 300);
  const hintSupplierId = supplierResolution?.kind === "existing" ? supplierResolution.id : undefined;
  const { data: sameReference } = usePurchaseOrders(
    { q: referenceQuery, supplierId: hintSupplierId, limit: 20 },
    { enabled: referenceQuery !== "" && hintSupplierId !== undefined },
  );
  const duplicateReference =
    hintSupplierId !== undefined && referenceQuery === header.reference.trim()
      ? referenceDuplicate(referenceQuery, sameReference?.items ?? [], purchase?.id)
      : null;
  const [headerErrors, setHeaderErrors] = useState<Partial<Record<keyof PurchaseHeaderDraft, string>>>(
    {},
  );

  const nextKey = useRef(1);
  const newLine = () => emptyLineDraft(`new-${nextKey.current++}`);
  const [lines, setLines] = useState<LineDraft[]>(() => (isEdit ? [] : [emptyLineDraft("new-0")]));
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, LineErrors>>({});
  const [unidentified, setUnidentified] = useState(false);

  const dirty =
    !isEdit &&
    (supplierText.trim() !== "" || header.reference.trim() !== "" || lines.some((l) => !isBlankLine(l)));
  useBeforeUnloadGuard(dirty && !saving);

  function patchHeader(patch: Partial<PurchaseHeaderDraft>) {
    setHeader((prev) => ({ ...prev, ...patch }));
    setUnidentified(false);
  }

  function patchLine(key: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    setUnidentified(false);
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  function addLine() {
    const line = newLine();
    setLines((prev) => [...prev, line]);
    setFocusKey(line.key);
  }

  function removeLine(key: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((line) => line.key !== key) : [newLine()]));
  }

  // The running total of the lines as typed, in the purchase's one currency label.
  const draftTotal = useMemo(() => {
    const entries = lines
      .filter((line) => !isBlankLine(line))
      .map((line) => {
        const price = parseMoneyInput(line.unitPrice, locale);
        const quantity = line.quantity.trim() === "" ? 1 : Number(line.quantity.trim());
        return {
          currency,
          amount:
            price.ok && price.minor !== null && Number.isInteger(quantity) && quantity > 0
              ? BigInt(price.minor) * BigInt(quantity)
              : null,
        };
      });
    return entries.length > 0 ? groupMoneyTotals(entries)[0] : undefined;
  }, [lines, locale, currency]);

  /** Enter in a line field adds the next line; Ctrl/Cmd+Enter anywhere saves (`lib/purchases/save-shortcut`). */
  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (!isSaveShortcut(event.nativeEvent)) return;
    event.preventDefault();
    // A held or repeated shortcut must not submit again while a save is running.
    if (saving || event.repeat || submitting.current) return;
    event.currentTarget.requestSubmit();
  }
  // With focus on nothing (a click on blank space, a removed line) the key never reaches the form (#1508).
  useEffect(() => {
    function onDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (!isSaveShortcut(event) || !isUnfocusedTarget(event.target, document) || !formRef.current) return;
      event.preventDefault();
      if (event.repeat || submitting.current) return;
      formRef.current.requestSubmit();
    }
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, []);
  function onLinesKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (!(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    addLine();
  }

  /** Map the schema's verdict on the final payload back to the header fields (lengths). */
  function schemaErrors(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
    if (result.success || !result.error) return false;
    // Only header fields can still be refused here (lines were checked field by field; the supplier id
    // is resolved later), so any other issue is left to the API.
    const next: Partial<Record<keyof PurchaseHeaderDraft, string>> = {};
    for (const issue of result.error.issues) {
      const field = String(issue.path[0]) as keyof PurchaseHeaderDraft;
      if (field in header) next[field] = t("tooLong");
    }
    setHeaderErrors(next);
    return Object.keys(next).length > 0;
  }

  /** The typed supplier name → a supplier id, creating the supplier when the name is new. */
  async function resolveSupplierId(): Promise<string | null | "stop"> {
    if (supplierText.trim() === "") return null;
    if (currentSupplier && currentSupplier.name.trim() === supplierText.trim()) return currentSupplier.id;
    const resolution = resolveSupplier(
      supplierText,
      await findSuppliersNamed(supplierText),
      currentSupplier,
      supplierChoice,
    );
    switch (resolution.kind) {
      case "none":
        return null;
      case "existing":
        return resolution.id;
      case "ambiguous":
        setSupplierError(t("supplierChooseError"));
        return "stop";
      case "new": {
        const created = await createSupplier.mutateAsync({ name: resolution.name });
        toast.success(t("supplierCreatedToast", { name: created.name }));
        return created.id;
      }
    }
  }

  function rememberTyped() {
    rememberSupplier(supplierText);
    rememberCurrency(currency);
    rememberCompany(header.company);
    rememberReference(header.reference);
    rememberInvoiceNumbers(header.invoiceNumbers);
    for (const line of lines) {
      rememberManufacturer(line.manufacturerText);
      rememberLineModel(line.modelText);
      rememberLineDescription(line.description);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    await runExclusive(submitting, () => save(form));
  }

  async function save(form: HTMLFormElement) {
    setSupplierError(undefined);
    setHeaderErrors({});
    const draft = { ...header, currency };

    if (!purchase) {
      // Validate everything typed before anything is written (a new supplier included).
      const check = toCreatePurchase(
        draft,
        supplierText.trim() ? "pending" : undefined,
        lines,
        locale,
      );
      if (!check.ok) {
        setErrors(check.lineErrors);
        setUnidentified(check.unidentified);
        scrollToFirstError(form);
        return;
      }
      if (schemaErrors(CreatePurchaseOrderSchema.safeParse(check.payload))) {
        scrollToFirstError(form);
        return;
      }
    } else {
      // Validate the header before anything is written — a new supplier included.
      const preview = toUpdatePurchase(draft, purchase.supplierId, purchase);
      if (preview && schemaErrors(UpdatePurchaseOrderSchema.safeParse(preview))) {
        scrollToFirstError(form);
        return;
      }
    }

    setSaving(true);
    try {
      const supplierId = await resolveSupplierId();
      if (supplierId === "stop") {
        scrollToFirstError(form);
        return;
      }
      if (purchase) {
        const payload = toUpdatePurchase(draft, supplierId, purchase);
        if (payload) {
          if (schemaErrors(UpdatePurchaseOrderSchema.safeParse(payload))) {
            scrollToFirstError(form);
            return;
          }
          await updatePurchase.mutateAsync({ id: purchase.id, data: payload });
          rememberTyped();
          toast.success(t("savedToast"));
        }
        router.push(`/purchases/${purchase.id}`);
        return;
      }
      const result = toCreatePurchase(draft, supplierId ?? undefined, lines, locale);
      if (!result.ok) return;
      const created = await createPurchase.mutateAsync(result.payload);
      rememberTyped();
      toast.success(t("createdToast"));
      router.push(`/purchases/${created.id}`);
    } catch (error) {
      notifyError(error, isEdit ? t("saveError") : t("createError"));
    } finally {
      setSaving(false);
    }
  }

  const statusOptions: { value: PurchaseOrderStatus; label: string }[] = [
    { value: "DRAFT", label: t("statusDraft") },
    { value: "ORDERED", label: t("statusOrdered") },
  ];

  const textField = (
    field: "reference" | "invoiceNumbers",
    label: string,
    placeholder?: string,
  ) => (
    <Field data-invalid={headerErrors[field] ? true : undefined}>
      <FieldLabel htmlFor={field}>{label}</FieldLabel>
      <SuggestInput
        id={field}
        value={header[field]}
        onValueChange={(value) => patchHeader({ [field]: value })}
        source={() => (field === "reference" ? references : invoiceNumbers)}
        recentKey={`purchase.${field}`}
        placeholder={placeholder}
        aria-invalid={headerErrors[field] ? true : undefined}
      />
      {headerErrors[field] ? <FieldError>{headerErrors[field]}</FieldError> : null}
    </Field>
  );

  const dateField = (field: "orderDate" | "expectedDate" | "invoiceDate", label: string) => (
    <Field>
      <FieldLabel htmlFor={field}>{label}</FieldLabel>
      <Input
        id={field}
        type="date"
        value={header[field]}
        onChange={(event) => patchHeader({ [field]: event.target.value })}
        className="font-mono"
      />
    </Field>
  );

  return (
    <form
      ref={formRef}
      id={FORM_ID}
      onSubmit={onSubmit}
      onKeyDown={onFormKeyDown}
      noValidate
      className="space-y-8"
    >
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SupplierField
            id="supplier"
            value={supplierText}
            onValueChange={(value) => {
              setSupplierText(value);
              setSupplierError(undefined);
              setUnidentified(false);
            }}
            chosenId={supplierChoice}
            onChosenIdChange={(id) => {
              setSupplierChoice(id);
              setSupplierError(undefined);
            }}
            resolution={supplierResolution}
            sameNamed={sameNamed}
            error={supplierError}
          />
          <div className="space-y-1.5">
            {textField("reference", t("reference"), t("referencePlaceholder"))}
            {duplicateReference ? (
              <p className="text-sm text-muted-foreground" role="status">
                {t.rich("referenceExists", {
                  link: (chunks) => (
                    <Link
                      href={`/purchases/${duplicateReference.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-foreground hover:underline"
                    >
                      {chunks}
                    </Link>
                  ),
                  name: titleOf(duplicateReference),
                })}
              </p>
            ) : null}
          </div>
          {dateField("orderDate", t("orderDate"))}
          <Field data-invalid={headerErrors.currency ? true : undefined}>
            <FieldLabel htmlFor="currency">{t("currency")}</FieldLabel>
            <SuggestInput
              id="currency"
              value={currency}
              onValueChange={(value) => {
                setCurrencyTouched(true);
                patchHeader({ currency: value });
              }}
              source={() => currencies}
              recentKey="currency"
              placeholder={t("currencyPlaceholder")}
              maxLength={32}
            />
            {headerErrors.currency ? <FieldError>{headerErrors.currency}</FieldError> : null}
            <p className="text-sm text-muted-foreground">{t("currencyHelp")}</p>
          </Field>
          {!isEdit ? (
            <Field>
              <FieldLabel id="status-label">{t("status")}</FieldLabel>
              <SegmentedChoice
                id="status"
                value={header.status}
                onValueChange={(status) => patchHeader({ status })}
                options={statusOptions}
                labelledBy="status-label"
              />
            </Field>
          ) : null}
        </div>

        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={moreOpen}
            aria-controls={moreOpen ? "purchase-more-details" : undefined}
            onClick={() => setMoreOpen((open) => !open)}
            className="-ml-2"
          >
            <ChevronDownIcon className={moreOpen ? "rotate-180" : undefined} />
            {t("moreDetails")}
          </Button>
          {moreOpen ? (
            <div id="purchase-more-details" className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {dateField("expectedDate", t("expectedDate"))}
              <Field>
                <FieldLabel htmlFor="deliveryLocationId">{t("deliveryLocation")}</FieldLabel>
                <LocationCombobox
                  id="deliveryLocationId"
                  value={header.deliveryLocationId}
                  onValueChange={(value) => patchHeader({ deliveryLocationId: value })}
                  placeholder={t("deliveryLocationPlaceholder")}
                />
              </Field>
              <Field data-invalid={headerErrors.company ? true : undefined}>
                <FieldLabel htmlFor="company">{t("company")}</FieldLabel>
                <SuggestInput
                  id="company"
                  value={header.company}
                  onValueChange={(value) => patchHeader({ company: value })}
                  source={() => companies}
                  recentKey="asset.company"
                />
                {headerErrors.company ? <FieldError>{headerErrors.company}</FieldError> : null}
              </Field>
              {textField("invoiceNumbers", t("invoiceNumbers"), t("invoiceNumbersPlaceholder"))}
              {dateField("invoiceDate", t("invoiceDate"))}
              <Field className="sm:col-span-2 lg:col-span-3" data-invalid={headerErrors.notes ? true : undefined}>
                <FieldLabel htmlFor="notes">{t("notes")}</FieldLabel>
                <Textarea
                  id="notes"
                  value={header.notes}
                  onChange={(event) => patchHeader({ notes: event.target.value })}
                  rows={2}
                />
                {headerErrors.notes ? <FieldError>{headerErrors.notes}</FieldError> : null}
              </Field>
            </div>
          ) : null}
        </div>
      </FieldGroup>

      {!isEdit ? (
        <section aria-labelledby="purchase-lines-heading" className="space-y-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="purchase-lines-heading" className="text-base font-semibold">
              {t("linesTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("linesHint")}</p>
          </div>
          <div className="space-y-4" onKeyDown={onLinesKeyDown}>
            {lines.map((line, index) => (
              <div key={line.key} className="rounded-lg border p-3">
                <LineFields
                  line={line}
                  index={index + 1}
                  onChange={(patch) => patchLine(line.key, patch)}
                  errors={errors[line.key]}
                  currency={currency}
                  autoFocus={line.key === focusKey}
                  onRemove={
                    lines.length > 1 || !isBlankLine(line) ? () => removeLine(line.key) : undefined
                  }
                />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button type="button" variant="outline" size="sm" onClick={addLine}>
              <PlusIcon />
              {t("addLine")}
            </Button>
            {draftTotal ? (
              <p className="text-sm">
                <span className="text-muted-foreground">{t("total")} </span>
                <span className="font-mono font-medium tabular-nums">
                  {draftTotal.amount !== null ? formatMoney(draftTotal.amount, locale, currency) : "—"}
                </span>
                {draftTotal.unpricedLines > 0 ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {t("unpricedLines", { count: draftTotal.unpricedLines })}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {unidentified ? (
        <Callout tone="warning" role="alert">
          {t("unidentified")}
        </Callout>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <p className="mr-auto text-xs text-muted-foreground">{t("saveShortcut")}</p>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={() => router.push(purchase ? `/purchases/${purchase.id}` : "/purchases")}
        >
          {tc("cancel")}
        </Button>
        <Button type="submit" form={FORM_ID} disabled={saving}>
          {saving && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? t("submitSave") : t("submitCreate")}
        </Button>
      </div>
    </form>
  );
}
