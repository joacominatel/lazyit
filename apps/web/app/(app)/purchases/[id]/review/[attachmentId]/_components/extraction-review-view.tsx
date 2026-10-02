"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  DocumentMagnifyingGlassIcon,
  ExclamationTriangleIcon,
  FlagIcon,
} from "@heroicons/react/24/outline";
import type { PurchaseExtractionDraft, PurchaseOrderDetail } from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "@/components/breadcrumb";
import { Callout } from "@/components/callout";
import { DetailPanel } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { SuggestInput } from "@/components/suggest-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAttachments } from "@/lib/api/hooks/use-attachments";
import {
  useAddPurchaseOrderLine,
  useExtractionStatus,
  useExtractPurchaseDocument,
  usePurchaseOrder,
  useUpdatePurchaseOrder,
  useUpdatePurchaseOrderLine,
} from "@/lib/api/hooks/use-purchase-orders";
import { useSuggestions } from "@/lib/api/hooks/use-suggestions";
import { notifyError } from "@/lib/api/notify-error";
import { useBeforeUnloadGuard } from "@/lib/hooks/use-before-unload-guard";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan, useMyPermissions } from "@/lib/hooks/use-permissions";
import { canExtract, extractionErrorKey, maxBytesFor, unavailableHint } from "@/lib/purchases/extraction";
import {
  buildReview,
  buildReviewPayload,
  checkCount,
  editProposal,
  editSupplier,
  type FieldProposal,
  proposalAction,
  type ReviewHeaderField,
  type ReviewLine,
  type ReviewState,
  supplierAction,
  totalsCheck,
} from "@/lib/purchases/extraction-review";
import type { LineDraft, LineErrors } from "@/lib/purchases/payload";
import { runExclusive } from "@/lib/purchases/submit-guard";
import { formatMoney } from "@/lib/utils/money";
import { LineFields } from "../../../../_components/line-fields";
import { usePurchaseTitle } from "../../../../_components/purchase-display";
import { SupplierField, useSupplierResolution, useSupplierSaver } from "../../../../_components/supplier-field";
import { DocumentPreview } from "./document-preview";
import { ActionBadge, Evidence, ProposalRow, ReadNote, Warnings } from "./review-fields";

/** The header labels, from the purchase form. */
const HEADER_LABEL: Record<ReviewHeaderField, string> = {
  reference: "reference",
  currency: "currency",
  orderDate: "orderDate",
  invoiceNumbers: "invoiceNumbers",
  invoiceDate: "invoiceDate",
};

/**
 * The extraction review (ADR-0099 §11, Phase 2 #1477; UX proposal §3.b): the document on one side, the
 * draft read from it on the other, as **proposed changes** to the purchase — nothing is saved until the
 * person selects *Save*, and then only through the purchase's ordinary write routes.
 *
 * - The read runs only on an explicit request: *Read this document* (on the purchase's documents, or *New
 *   purchase from a document*, which lands here with `?read=1`, dropped from the URL at once so a reload never
 *   sends the document again). It is never called unless `GET …/extraction/status` says available for this
 *   document's type.
 * - Each value shows what was read (text and page) on hover or focus; a value not read stays blank and says
 *   so; the API's warnings are spelled out where they apply, counted in the header, and jumped to.
 * - Filling an empty field starts ticked, replacing a value never does, an equal value is left out. The
 *   supplier is the one matched (by tax ID or name) with *use this / create new / choose*; a line's model is
 *   the one matched or suggested. Lines the purchase already has (same description) propose field changes.
 * - The totals check compares the lines, as corrected, with the printed net or gross — never stored.
 */
export function ExtractionReviewView({
  purchaseId,
  attachmentId,
  autoRead,
}: {
  purchaseId: string;
  attachmentId: string;
  autoRead: boolean;
}) {
  const t = useTranslations("purchases.extraction");
  const tList = useTranslations("purchases.list");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const titleOf = usePurchaseTitle();
  const canWrite = useCan("purchaseOrder:write");
  const isAdmin = useCan("settings:manage");
  const { isLoading: permissionsLoading } = useMyPermissions();
  const { data: purchase, isLoading, isError, error, refetch } = usePurchaseOrder(purchaseId);
  const { data: attachments, isLoading: attachmentsLoading } = useAttachments("purchaseOrder", purchaseId);
  const attachment = attachments?.find((item) => item.id === attachmentId);
  const {
    data: status,
    isLoading: statusLoading,
    isError: statusFailed,
  } = useExtractionStatus({ enabled: canWrite });
  const extract = useExtractPurchaseDocument();
  const [draft, setDraft] = useState<PurchaseExtractionDraft | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [builtFor, setBuiltFor] = useState<string | null>(null);
  const started = useRef(false);
  const eligible = attachment !== undefined && canExtract(status, attachment);

  // The review is built once per draft, against the purchase as it was read — adjusted during render.
  if (draft && purchase && attachment && builtFor !== draft.extractionId) {
    setBuiltFor(draft.extractionId);
    setReview(buildReview(draft, purchase, attachment.originalName, locale));
  }

  function read() {
    if (!eligible || extract.isPending) return;
    setDraft(null);
    setReview(null);
    extract.mutate({ id: purchaseId, attachmentId }, { onSuccess: setDraft });
  }

  // *New purchase from a document* asks for the read with `?read=1`; it runs once, and the flag leaves the
  // URL straight away so a reload shows the explicit button instead of sending the document again.
  // It waits until the permissions, the document and the status are all known, so it never decides early.
  const decided =
    !permissionsLoading && !attachmentsLoading && (!canWrite || status !== undefined || statusFailed);
  useEffect(() => {
    if (!autoRead || started.current || !decided) return;
    started.current = true;
    router.replace(pathname);
    if (eligible) extract.mutate({ id: purchaseId, attachmentId }, { onSuccess: setDraft });
  }, [autoRead, decided, eligible, router, pathname, extract, purchaseId, attachmentId]);

  const title = purchase ? titleOf(purchase) : "";
  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: tList("title"), href: "/purchases" },
          { label: title, href: `/purchases/${purchaseId}` },
          { label: t("breadcrumb") },
        ]}
      />
    ),
    [tList, t, title, purchaseId],
  );

  if (isLoading || attachmentsLoading) {
    return <Skeleton className="h-96 w-full" />;
  }
  if (isError || !purchase) {
    return <ErrorState title={t("notFound")} onRetry={() => refetch()} error={error} />;
  }
  if (!attachment) {
    return (
      <Callout tone="warning" icon={<ExclamationTriangleIcon />} role="alert">
        <p className="text-sm font-medium">{t("documentGone")}</p>
        <Button size="sm" variant="outline" className="mt-2" asChild>
          <Link href={`/purchases/${purchaseId}`}>{t("backToPurchase")}</Link>
        </Button>
      </Callout>
    );
  }

  // Why the read is not offered here, if it is not: only an admin is told an AI setting; a document of another
  // type, or past the size cap, says so to anyone.
  const unavailable = !canWrite
    ? "notOffered"
    : !status
      ? null
      : !status.available
        ? (unavailableHint(status.reason, isAdmin) ?? "notOffered")
        : !eligible
          ? "documentType"
          : null;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={breadcrumb}
        title={t("title")}
        subtitle={attachment.originalName}
        icon={DocumentMagnifyingGlassIcon}
        pillar="inventory"
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="lg:sticky lg:top-4 lg:h-[calc(100vh-6rem)] lg:self-start">
          <DocumentPreview purchaseId={purchaseId} attachment={attachment} />
        </div>
        <div className="min-w-0">
          {review && draft ? (
            <ReviewForm
              purchase={purchase}
              draft={draft}
              review={review}
              onChange={setReview}
            />
          ) : extract.isPending ? (
            <div className="space-y-3" role="status" aria-live="polite">
              <p className="flex items-center gap-2 text-sm font-medium">
                <ArrowPathIcon className="size-4 animate-spin" aria-hidden />
                {t("reading")}
              </p>
              <p className="text-sm text-muted-foreground">{t("readingHelp")}</p>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : extract.isError ? (
            <Callout tone="warning" icon={<ExclamationTriangleIcon />} role="alert">
              <p className="text-sm font-medium">{t(`errors.${extractionErrorKey(extract.error)}`)}</p>
              <p className="text-sm">{t("nothingFilled")}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {eligible ? (
                  <Button size="sm" variant="outline" onClick={read}>
                    {t("tryAgain")}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" asChild>
                  <Link href={`/purchases/${purchaseId}`}>{t("backToPurchase")}</Link>
                </Button>
              </div>
            </Callout>
          ) : unavailable ? (
            <Callout tone="info" icon={<ExclamationTriangleIcon />}>
              <p className="text-sm">
                {t(`off.${unavailable}`, {
                  max: Math.floor((status ? maxBytesFor(status, attachment.mimeType) : 0) / (1024 * 1024)),
                })}
              </p>
            </Callout>
          ) : (
            <DetailPanel title={t("readTitle")}>
              <div className="space-y-3 text-sm">
                <p>{t("readIntro")}</p>
                <p className="text-muted-foreground">{t("readDisclosure")}</p>
                <Button onClick={read} disabled={!eligible || statusLoading}>
                  <DocumentMagnifyingGlassIcon />
                  {t("readAction")}
                </Button>
              </div>
            </DetailPanel>
          )}
        </div>
      </div>
    </div>
  );
}

/** The draft as proposed changes, and Save. */
function ReviewForm({
  purchase,
  draft,
  review,
  onChange,
}: {
  purchase: PurchaseOrderDetail;
  draft: PurchaseExtractionDraft;
  review: ReviewState;
  onChange: (next: ReviewState) => void;
}) {
  const t = useTranslations("purchases.extraction");
  const tForm = useTranslations("purchases.form");
  const tLine = useTranslations("purchases.line");
  const locale = useLocale();
  const router = useRouter();
  const { date } = useFormatters();
  const saveSupplier = useSupplierSaver();
  const updatePurchase = useUpdatePurchaseOrder();
  const addLine = useAddPurchaseOrderLine();
  const updateLine = useUpdatePurchaseOrderLine();
  const submitting = useRef(false);
  // What a failed save already wrote, so a retry never writes it twice.
  const done = useRef<{ header: boolean; items: Set<string> }>({ header: false, items: new Set() });
  const [saving, setSaving] = useState(false);
  const [headerErrors, setHeaderErrors] = useState<Partial<Record<ReviewHeaderField, string>>>({});
  const [lineErrors, setLineErrors] = useState<Record<number, LineErrors>>({});
  const [supplierError, setSupplierError] = useState<string>();
  const flagIndex = useRef(0);
  // Values the document read exactly as the purchase has them, unflagged, are not changes: left out. Decided
  // once, from the draft as read, so a row never vanishes while someone types in it.
  const [unchanged] = useState<ReadonlySet<ReviewHeaderField>>(
    () =>
      new Set(
        review.header
          .filter((item) => proposalAction(item.field, item.current, item.proposed) === "same" && item.warnings.length === 0)
          .map((item) => item.field),
      ),
  );
  const pane = useRef<HTMLDivElement>(null);
  const supplier = review.supplier;
  const { resolution, sameNamed } = useSupplierResolution(supplier.text, null, supplier.chosenId);
  const currencyItem = review.header.find((item) => item.field === "currency")!;
  const currencies = useSuggestions("currency", currencyItem.proposed);
  // The label the lines are in once saved: the document's when it is applied, else the purchase's.
  const lineCurrency = currencyItem.checked ? currencyItem.proposed : (purchase.currency ?? "");
  const checks = checkCount(review);
  const totals = totalsCheck(review.lines, draft.totals, locale);
  const truncated = draft.warnings.some((w) => w.code === "LINES_TRUNCATED");
  const built = buildReviewPayload(review, locale);
  const changes = built.ok ? built.changes : null;

  useBeforeUnloadGuard(!saving);

  function setHeader(field: ReviewHeaderField, next: FieldProposal<ReviewHeaderField>) {
    onChange({ ...review, header: review.header.map((item) => (item.field === field ? next : item)) });
    setHeaderErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function setLine(index: number, next: ReviewLine) {
    onChange({ ...review, lines: review.lines.map((line) => (line.index === index ? next : line)) });
    setLineErrors((prev) => {
      const copy = { ...prev };
      delete copy[index];
      return copy;
    });
  }

  /** The "n to check" counter jumps to the next flagged value. */
  function nextFlag() {
    const flags = pane.current?.querySelectorAll<HTMLElement>("[data-review-flag]");
    if (!flags || flags.length === 0) return;
    const target = flags[flagIndex.current % flags.length]!;
    flagIndex.current += 1;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.querySelector<HTMLElement>("input, button[role='combobox'], button[role='radio']")?.focus({
      preventScroll: true,
    });
  }

  async function save() {
    const result = buildReviewPayload(review, locale);
    if (!result.ok) {
      setHeaderErrors(
        Object.fromEntries(Object.keys(result.headerErrors).map((field) => [field, t("invalidValue")])),
      );
      setLineErrors(result.lineErrors);
      requestAnimationFrame(() =>
        pane.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(),
      );
      return;
    }
    if (result.changes === 0) {
      router.push(`/purchases/${purchase.id}`);
      return;
    }
    setSaving(true);
    try {
      const header = { ...(result.payload.header ?? {}) };
      if (result.payload.supplier && !done.current.header) {
        const resolved = await saveSupplier(
          result.payload.supplier.text,
          result.payload.supplier.chosenId,
          result.payload.supplier.taxId,
        );
        if (resolved === "ambiguous") {
          setSupplierError(tForm("supplierChooseError"));
          return;
        }
        if (resolved.created) toast.success(tForm("supplierCreatedToast", { name: resolved.created }));
        header.supplierId = resolved.id;
      }
      if (Object.keys(header).length > 0 && !done.current.header) {
        await updatePurchase.mutateAsync({ id: purchase.id, data: header });
        done.current.header = true;
      }
      for (const { index, line } of result.payload.addLines) {
        const key = `add-${index}`;
        if (done.current.items.has(key)) continue;
        await addLine.mutateAsync({ id: purchase.id, data: line });
        done.current.items.add(key);
      }
      for (const { index, lineId, data } of result.payload.lineUpdates) {
        const key = `update-${index}`;
        if (done.current.items.has(key)) continue;
        await updateLine.mutateAsync({ id: purchase.id, lineId, data });
        done.current.items.add(key);
      }
      toast.success(t("savedToast", { count: result.changes }));
      router.push(`/purchases/${purchase.id}`);
    } catch (err) {
      notifyError(err, t("saveError"));
    } finally {
      setSaving(false);
    }
  }

  const supplierAct = supplierAction(supplier);
  const matchNote = supplier.match
    ? supplier.match.by === "TAX_ID"
      ? t("supplierMatchedTaxId")
      : t("supplierMatchedName")
    : null;

  return (
    <div ref={pane} className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {checks > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={nextFlag}>
            <FlagIcon />
            {t("toCheck", { count: checks })}
          </Button>
        ) : (
          <StatusBadge tone="success">{t("nothingFlagged")}</StatusBadge>
        )}
        <TotalsBanner totals={totals} currency={lineCurrency} />
      </div>
      {truncated ? (
        <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
          <p className="text-sm">{t("warnings.LINES_TRUNCATED")}</p>
        </Callout>
      ) : null}
      {review.holder ? null : (
        <p className="text-sm text-muted-foreground">{t("proposedIntro")}</p>
      )}

      <section aria-labelledby="review-purchase-heading" className="space-y-3">
        <h2 id="review-purchase-heading" className="text-base font-semibold">
          {t("purchaseSection")}
        </h2>

        <div
          className={
            supplier.warnings.length > 0 || supplier.readName === ""
              ? "group/field grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 rounded-lg border border-warning/50 bg-warning/5 p-3"
              : "group/field grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 rounded-lg border p-3"
          }
          {...(supplier.warnings.length > 0 ? { "data-review-flag": "" } : {})}
        >
          <Checkbox
            className="mt-1"
            checked={supplier.checked}
            disabled={supplierAct === "unread" || supplierAct === "same"}
            onCheckedChange={(checked) =>
              onChange({ ...review, supplier: { ...supplier, checked: checked === true } })
            }
            aria-label={t("applyField", { field: tForm("supplier") })}
          />
          <div className="min-w-0 space-y-1.5">
            <SupplierField
              id="review-supplier"
              value={supplier.text}
              onValueChange={(value) => {
                onChange({ ...review, supplier: editSupplier(supplier, value, "") });
                setSupplierError(undefined);
              }}
              chosenId={supplier.chosenId}
              onChosenIdChange={(id) => onChange({ ...review, supplier: editSupplier(supplier, supplier.text, id) })}
              resolution={resolution}
              sameNamed={sameNamed}
              error={supplierError}
            />
            <div className="flex flex-wrap items-center gap-2">
              {supplierAct !== "unread" ? (
                <ActionBadge
                  field="supplier"
                  current={supplier.current?.name ?? ""}
                  proposed={supplierAct === "same" ? (supplier.current?.name ?? "") : supplier.text}
                />
              ) : null}
              {matchNote ? (
                <StatusBadge tone={supplier.match?.by === "TAX_ID" ? "success" : "warning"}>{matchNote}</StatusBadge>
              ) : null}
            </div>
            {supplier.match && supplier.readName && supplier.readName.trim() !== supplier.match.name.trim() ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={supplier.chosenId === supplier.match.id ? "secondary" : "outline"}
                  onClick={() =>
                    onChange({ ...review, supplier: editSupplier(supplier, supplier.match!.name, supplier.match!.id) })
                  }
                >
                  {t("useSupplier", { name: supplier.match.name })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={supplier.text === supplier.readName && !supplier.chosenId ? "secondary" : "outline"}
                  onClick={() => onChange({ ...review, supplier: editSupplier(supplier, supplier.readName, "") })}
                >
                  {t("createSupplier", { name: supplier.readName })}
                </Button>
              </div>
            ) : null}
            {supplierAct === "replace" && supplier.current ? (
              <p className="text-xs text-muted-foreground">{t("now", { value: supplier.current.name })}</p>
            ) : null}
            <ReadNote read={supplier.readName !== ""} evidence={supplier.evidence} warnings={supplier.warnings} />
            {supplier.readTaxId ? <Evidence evidence={supplier.taxIdEvidence} /> : null}
          </div>
        </div>

        {review.header.map((item) => {
          if (unchanged.has(item.field)) return null;
          const label = tForm(HEADER_LABEL[item.field]);
          const isDate = item.field === "orderDate" || item.field === "invoiceDate";
          const currentText = isDate && item.current ? date(`${item.current}T00:00:00.000Z`) : item.current;
          const currencyNote =
            item.field === "currency" && proposalAction("currency", item.current, item.proposed) === "replace" ? (
              <p className="text-xs text-muted-foreground">{t("currencyNote")}</p>
            ) : null;
          return (
            <ProposalRow
              key={item.field}
              id={`review-${item.field}`}
              label={label}
              item={item}
              type={isDate ? "date" : "text"}
              currentText={currentText}
              note={currencyNote}
              error={headerErrors[item.field]}
              onEdit={(value) => setHeader(item.field, editProposal(item, value))}
              onToggle={(checked) => setHeader(item.field, { ...item, checked })}
            >
              {item.field === "currency" ? (
                <SuggestInput
                  id="review-currency"
                  value={item.proposed}
                  onValueChange={(value) => setHeader("currency", editProposal(item, value))}
                  source={() => currencies}
                  recentKey="currency"
                  maxLength={32}
                />
              ) : undefined}
            </ProposalRow>
          );
        })}

        {review.holder && purchase.status === "DRAFT" ? (
          <label className="flex items-center gap-3 rounded-lg border p-3 text-sm">
            <Checkbox
              checked={review.markOrdered}
              onCheckedChange={(checked) => onChange({ ...review, markOrdered: checked === true })}
            />
            {t("markOrdered")}
          </label>
        ) : null}
      </section>

      <section aria-labelledby="review-lines-heading" className="space-y-3">
        <h2 id="review-lines-heading" className="text-base font-semibold">
          {t("linesSection", { count: review.lines.length })}
        </h2>
        {review.lines.length === 0 ? <p className="text-sm text-muted-foreground">{t("noLines")}</p> : null}
        {review.lines.map((line) =>
          line.target ? (
            <MatchedLine
              key={line.index}
              line={line}
              currency={purchase.currency ?? ""}
              errors={lineErrors[line.index]}
              onChange={(next) => setLine(line.index, next)}
            />
          ) : (
            <div
              key={line.index}
              className={
                line.checked ? "space-y-3 rounded-lg border p-3" : "space-y-3 rounded-lg border border-dashed p-3 opacity-80"
              }
            >
              <label className="flex items-center gap-3 text-sm font-medium">
                <Checkbox
                  checked={line.checked}
                  onCheckedChange={(checked) => setLine(line.index, { ...line, checked: checked === true })}
                />
                {t("addLine", { index: line.index + 1 })}
                <StatusBadge tone="info">{t("action.add")}</StatusBadge>
              </label>
              <Warnings codes={line.warnings.line} />
              <LineFields
                line={line.draft}
                index={line.index + 1}
                onChange={(patch) =>
                  setLine(line.index, { ...line, draft: { ...line.draft, ...patch }, checked: true })
                }
                errors={lineErrors[line.index]}
                currency={lineCurrency}
                annotations={lineAnnotations(line, t, tLine)}
                flagged={lineFlags(line)}
              />
              {line.evidence.lineTotal || line.warnings.lineTotal ? (
                <div className="group/field text-xs" {...(line.warnings.lineTotal ? { "data-review-flag": "" } : {})}>
                  <Evidence evidence={line.evidence.lineTotal ?? null} always={Boolean(line.warnings.lineTotal)} />
                  <Warnings codes={line.warnings.lineTotal} />
                </div>
              ) : null}
            </div>
          ),
        )}
      </section>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
        <p className="mr-auto text-xs text-muted-foreground">{t("saveNote")}</p>
        <Button type="button" variant="outline" disabled={saving} asChild>
          <Link href={`/purchases/${purchase.id}`}>{t("discard")}</Link>
        </Button>
        <Button
          type="button"
          disabled={saving}
          onClick={() => void runExclusive(submitting, save)}
        >
          {saving && <ArrowPathIcon className="animate-spin" />}
          {changes === null || changes > 0 ? t("save", { count: changes ?? 0 }) : t("saveNothing")}
        </Button>
      </div>
    </div>
  );
}

/** The fields the review asks the person to check on a new line. */
function lineFlags(line: ReviewLine): ReadonlySet<keyof LineDraft> {
  const out = new Set<keyof LineDraft>();
  for (const field of ["description", "manufacturerText", "modelText", "quantity", "unitPrice", "warrantyMonths"] as const) {
    if (line.warnings[field]?.length) out.add(field);
  }
  if (line.modelMatch?.by === "NAME") out.add("assetModelId");
  return out;
}

/** Under each field of a new line: what was read, "not read", the warnings, and the model suggestion. */
function lineAnnotations(
  line: ReviewLine,
  t: ReturnType<typeof useTranslations>,
  tLine: ReturnType<typeof useTranslations>,
) {
  const note = (field: "description" | "manufacturerText" | "modelText" | "quantity" | "unitPrice" | "warrantyMonths") => (
    <>
      <ReadNote
        read={!line.unread.includes(field)}
        evidence={line.evidence[field] ?? null}
        warnings={line.warnings[field]}
      />
      {field === "quantity" && line.unread.includes("quantity") ? <p>{t("quantityNeeded")}</p> : null}
    </>
  );
  return {
    kind: line.kindRead ? undefined : <p className="font-medium text-warning-text">{t("kindNotRead", { kind: tLine("kindAsset") })}</p>,
    description: note("description"),
    manufacturerText: note("manufacturerText"),
    modelText: note("modelText"),
    quantity: note("quantity"),
    unitPrice: note("unitPrice"),
    warrantyMonths: note("warrantyMonths"),
    assetModelId:
      line.modelMatch && line.draft.assetModelId === line.modelMatch.id ? (
        <p className={line.modelMatch.by === "NAME" ? "font-medium text-warning-text" : undefined}>
          {line.modelMatch.by === "LINE_MEMORY" ? t("modelMatchedMemory") : t("modelSuggested")}
        </p>
      ) : undefined,
  };
}

/** A document line the purchase already has: its field changes, each ticked or not. */
function MatchedLine({
  line,
  currency,
  errors,
  onChange,
}: {
  line: ReviewLine;
  currency: string;
  errors?: LineErrors;
  onChange: (next: ReviewLine) => void;
}) {
  const t = useTranslations("purchases.extraction");
  const tLine = useTranslations("purchases.line");
  const locale = useLocale();
  const target = line.target!;
  const changes = line.fields.filter((item) => {
    const action = proposalAction(item.field, item.current, item.proposed);
    return action === "fill" || action === "replace" || (action === "unread" && item.warnings.length > 0);
  });
  const label = (field: string) =>
    field === "quantity" ? tLine("quantity") : field === "unitPrice" ? tLine("unitPrice") : tLine("warrantyMonths");
  const errorOf = (field: string) =>
    errors?.[field as keyof LineErrors] ? t("invalidValue") : undefined;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {t("existingLine", { line: target.description })}
        <StatusBadge tone="neutral">{t("onPurchase")}</StatusBadge>
      </p>
      <Warnings codes={line.warnings.line} />
      {changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("lineUnchanged")}</p>
      ) : (
        changes.map((item) => (
          <ProposalRow
            key={item.field}
            id={`review-line-${line.index}-${item.field}`}
            label={label(item.field)}
            item={item}
            currentText={
              item.field === "unitPrice" && target.unitPrice !== null
                ? formatMoney(target.unitPrice, locale, currency)
                : undefined
            }
            error={errorOf(item.field)}
            onEdit={(value) =>
              onChange({ ...line, fields: line.fields.map((f) => (f.field === item.field ? editProposal(f, value) : f)) })
            }
            onToggle={(checked) =>
              onChange({ ...line, fields: line.fields.map((f) => (f.field === item.field ? { ...f, checked } : f)) })
            }
          />
        ))
      )}
    </div>
  );
}

/** The totals self-check: match, mismatch by how much, or nothing to compare. */
function TotalsBanner({ totals, currency }: { totals: ReturnType<typeof totalsCheck>; currency: string }) {
  const t = useTranslations("purchases.extraction.totals");
  const locale = useLocale();
  const money = (minor: number | null) => (minor === null ? "—" : formatMoney(minor, locale, currency));
  if (totals.state === "unknown") {
    return totals.net === null && totals.gross === null ? null : (
      <p className="text-sm text-muted-foreground">{t("unknown")}</p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm" role="status">
      {totals.state === "match" ? (
        <CheckCircleIcon className="size-4 text-success" aria-hidden />
      ) : (
        <ExclamationTriangleIcon className="size-4 text-warning-text" aria-hidden />
      )}
      <span>
        {t("compare", {
          lines: money(totals.linesTotal),
          printed: money(totals.net ?? totals.gross),
          which: totals.net !== null ? "net" : "gross",
        })}
      </span>
      <StatusBadge tone={totals.state === "match" ? "success" : "warning"}>
        {totals.state === "match"
          ? t("match")
          : t("mismatch", { amount: money(totals.difference === null ? null : Math.abs(totals.difference)) })}
      </StatusBadge>
      {totals.state === "mismatch" && totals.incomplete > 0 ? (
        <span className="text-muted-foreground">{t("incomplete", { count: totals.incomplete })}</span>
      ) : null}
    </p>
  );
}
