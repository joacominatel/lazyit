"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InboxArrowDownIcon,
} from "@heroicons/react/24/outline";
import {
  type AssetStatus,
  AssetStatusSchema,
  type ReceiveAssetsResult,
  ReceiveAssetsSchema,
  RECEIVE_ASSETS_MAX_QUANTITY,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AssetModelCombobox } from "@/components/asset-model-combobox";
import { Callout } from "@/components/callout";
import { LocationCombobox } from "@/components/location-combobox";
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
import { useAssetCompanies } from "@/lib/api/hooks/use-assets";
import { useReceiveAssets } from "@/lib/api/hooks/use-asset-receive";
import { notifyError } from "@/lib/api/notify-error";
import { majorToMinor } from "@/lib/utils/money";
import { useAssetStatusLabel } from "./asset-status-badge";

/** Split the serials textarea into trimmed, non-empty lines (one serial per unit). */
function parseSerials(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

type FieldErrors = Partial<
  Record<"modelId" | "quantity" | "serials", string>
>;

/**
 * Bulk receiving (ADR-0089 Part A, #1029) — mint N identical assets from ONE AssetModel in a single
 * action ("we just received 20 ThinkPads"). Self-contained: renders its own trigger button plus the
 * dialog. Gate it with `asset:write` at the call site (like the New-asset button). The form fields are
 * the shared context applied to EVERY minted unit; the optional serials paste assigns one serial per
 * unit (empty, or exactly `quantity` lines — enforced by the shared schema before any write).
 *
 * The endpoint is a PARTIAL-SUCCESS one (a per-unit create loop): it returns `{ created, failed }` and
 * a partial (or total) failure is NOT a request error. So the dialog switches to a RESULT view that
 * reports how many landed and lists each failed unit by its 1-based position with the reason — by
 * design, not an error toast. Money is entered in MAJOR units and converted to minor units on submit
 * (#954), never re-coerced downstream.
 */
export function ReceiveStockButton() {
  const t = useTranslations("assets.receive");
  const tc = useTranslations("common");
  const statusLabel = useAssetStatusLabel();
  const receive = useReceiveAssets();
  const { data: companies } = useAssetCompanies();

  const [open, setOpen] = useState(false);

  // Form fields (local state — the mixed serials-text→array + major→minor-money coercion makes a plain
  // controlled form simpler than RHF here; the shared schema is the real validator on submit).
  const [modelId, setModelId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [status, setStatus] = useState<AssetStatus>("OPERATIONAL");
  const [locationId, setLocationId] = useState("");
  const [company, setCompany] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [purchaseCost, setPurchaseCost] = useState("");
  const [notes, setNotes] = useState("");
  const [serials, setSerials] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  // The partial-success envelope from the last successful call — drives the RESULT view.
  const [result, setResult] = useState<ReceiveAssetsResult | null>(null);

  function resetForm() {
    setModelId("");
    setQuantity("1");
    setStatus("OPERATIONAL");
    setLocationId("");
    setCompany("");
    setPurchaseDate("");
    setPurchaseCost("");
    setNotes("");
    setSerials("");
    setErrors({});
    setResult(null);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Reset on close so a reused dialog never shows a stale result/form.
    if (!next) resetForm();
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const serialLines = parseSerials(serials);
    // Build the payload and let the shared schema validate it (single source of truth): quantity
    // bounds, the serials-count refinement, and the field shapes all live there. Omit the optional
    // id/date fields when blank (an empty string fails `cuid()`/`datetime()`); free-text fields
    // tolerate "" via `optionalText`.
    const candidate = {
      modelId,
      quantity: Number(quantity),
      status,
      ...(locationId ? { locationId } : {}),
      ...(company.trim() ? { company: company.trim() } : {}),
      ...(purchaseDate ? { purchaseDate: `${purchaseDate}T00:00:00.000Z` } : {}),
      purchaseCost: majorToMinor(purchaseCost),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(serialLines.length > 0 ? { serials: serialLines } : {}),
    };

    const parsed = ReceiveAssetsSchema.safeParse(candidate);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === "modelId") next.modelId = t("modelRequired");
        else if (key === "quantity") next.quantity = t("quantityInvalid");
        else if (key === "serials")
          next.serials = t("serialsCountMismatch", { quantity: quantity || "0" });
      }
      // Fallback: a validation failure with no field we render inline → surface the model requirement,
      // the only always-required field the user might have missed.
      if (Object.keys(next).length === 0) next.modelId = t("modelRequired");
      setErrors(next);
      return;
    }

    setErrors({});
    receive.mutate(parsed.data, {
      onSuccess: (envelope) => {
        setResult(envelope);
        if (envelope.failed.length === 0) {
          toast.success(
            t("createdToast", { count: envelope.created.length }),
          );
        }
      },
      onError: (error) => notifyError(error, t("submitError")),
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <InboxArrowDownIcon />
        {t("button")}
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          {result ? (
            <ReceiveResult
              result={result}
              modelId={modelId}
              onReceiveMore={resetForm}
              onDone={() => handleOpenChange(false)}
            />
          ) : (
            <>
              <form
                id="receive-stock-form"
                onSubmit={handleSubmit}
                noValidate
                className="max-h-[60vh] overflow-y-auto pr-1"
              >
                <FieldGroup>
                  <Field data-invalid={errors.modelId ? true : undefined}>
                    <FieldLabel htmlFor="receive-model" required>
                      {t("model")}
                    </FieldLabel>
                    <AssetModelCombobox
                      id="receive-model"
                      value={modelId}
                      onValueChange={(value) => setModelId(value)}
                      ariaInvalid={Boolean(errors.modelId)}
                      placeholder={t("modelPlaceholder")}
                      searchPlaceholder={t("searchModel")}
                      emptyText={t("noModels")}
                    />
                    <FieldDescription>{t("modelHelp")}</FieldDescription>
                    {errors.modelId ? (
                      <FieldError errors={[{ message: errors.modelId }]} />
                    ) : null}
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2">
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
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        aria-invalid={Boolean(errors.quantity) || undefined}
                      />
                      <FieldDescription>
                        {t("quantityHelp", { max: RECEIVE_ASSETS_MAX_QUANTITY })}
                      </FieldDescription>
                      {errors.quantity ? (
                        <FieldError errors={[{ message: errors.quantity }]} />
                      ) : null}
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="receive-status">
                        {t("status")}
                      </FieldLabel>
                      <Select
                        value={status}
                        onValueChange={(value) =>
                          setStatus(value as AssetStatus)
                        }
                      >
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
                      <FieldLabel htmlFor="receive-location">
                        {t("location")}
                      </FieldLabel>
                      <LocationCombobox
                        id="receive-location"
                        value={locationId}
                        onValueChange={(value) => setLocationId(value)}
                        placeholder={t("locationPlaceholder")}
                        searchPlaceholder={t("searchLocation")}
                        emptyText={t("noLocations")}
                      />
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="receive-company">
                        {t("company")}
                      </FieldLabel>
                      <Input
                        id="receive-company"
                        value={company}
                        onChange={(e) => setCompany(e.target.value)}
                        list="receive-company-options"
                        placeholder={t("companyPlaceholder")}
                      />
                      <datalist id="receive-company-options">
                        {(companies ?? []).map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="receive-purchase-date">
                        {t("purchaseDate")}
                      </FieldLabel>
                      <Input
                        id="receive-purchase-date"
                        type="date"
                        value={purchaseDate}
                        onChange={(e) => setPurchaseDate(e.target.value)}
                      />
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="receive-cost">
                        {t("purchaseCost")}
                      </FieldLabel>
                      <Input
                        id="receive-cost"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={purchaseCost}
                        onChange={(e) => setPurchaseCost(e.target.value)}
                        placeholder={t("purchaseCostPlaceholder")}
                      />
                      <FieldDescription>
                        {t("purchaseCostHelp")}
                      </FieldDescription>
                    </Field>
                  </div>

                  <Field>
                    <FieldLabel htmlFor="receive-notes">{t("notes")}</FieldLabel>
                    <Textarea
                      id="receive-notes"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={2}
                      placeholder={t("notesPlaceholder")}
                    />
                  </Field>

                  <Field data-invalid={errors.serials ? true : undefined}>
                    <FieldLabel htmlFor="receive-serials">
                      {t("serials")}
                    </FieldLabel>
                    <Textarea
                      id="receive-serials"
                      value={serials}
                      onChange={(e) => setSerials(e.target.value)}
                      rows={3}
                      className="font-mono"
                      placeholder={t("serialsPlaceholder")}
                      aria-invalid={Boolean(errors.serials) || undefined}
                    />
                    <FieldDescription>{t("serialsHelp")}</FieldDescription>
                    {errors.serials ? (
                      <FieldError errors={[{ message: errors.serials }]} />
                    ) : null}
                  </Field>
                </FieldGroup>
              </form>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  disabled={receive.isPending}
                >
                  {tc("cancel")}
                </Button>
                <Button
                  type="submit"
                  form="receive-stock-form"
                  disabled={receive.isPending}
                >
                  {receive.isPending && (
                    <ArrowPathIcon className="animate-spin" />
                  )}
                  {t("submit")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The partial-success RESULT view (ADR-0089 A2). `created.length` assets landed; `failed` lists the
 * per-unit failures by 0-based batch index with a reason. A total failure (`created.length === 0`) is
 * still a valid 201 — surfaced as an informational notice, never an error.
 */
function ReceiveResult({
  result,
  modelId,
  onReceiveMore,
  onDone,
}: {
  result: ReceiveAssetsResult;
  modelId: string;
  onReceiveMore: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("assets.receive");
  const created = result.created.length;
  const failed = result.failed;

  return (
    <div className="space-y-4">
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

      <DialogFooter>
        {created > 0 ? (
          <Button variant="outline" asChild>
            <Link href={modelId ? `/assets?model=${modelId}` : "/assets"}>
              {t("result.viewInventory")}
            </Link>
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
