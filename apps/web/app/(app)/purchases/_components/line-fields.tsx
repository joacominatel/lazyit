"use client";

import { TrashIcon } from "@heroicons/react/24/outline";
import type { PurchaseOrderLineKind } from "@lazyit/shared";
import { Badge } from "@/components/ui/badge";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ApplicationCombobox } from "@/components/application-combobox";
import { AssetModelCombobox } from "@/components/asset-model-combobox";
import { ConsumableCombobox } from "@/components/consumable-combobox";
import { MoneyField } from "@/components/money-input";
import { SuggestInput } from "@/components/suggest-input";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useSuggestions } from "@/lib/api/hooks/use-suggestions";
import { useCan } from "@/lib/hooks/use-permissions";
import { isWritableKind, type LineDraft, type LineErrors } from "@/lib/purchases/payload";
import { formatMoney, MONEY_MAX, parseMoneyInput } from "@/lib/utils/money";
import { SegmentedChoice } from "./segmented-choice";

/** quantity × unit price as typed, or `null` while either is blank or unreadable. */
function previewTotal(line: LineDraft, locale: string): number | null {
  const price = parseMoneyInput(line.unitPrice, locale);
  const quantity = line.quantity.trim() === "" ? 1 : Number(line.quantity.trim());
  if (!price.ok || price.minor === null || !Number.isInteger(quantity) || quantity < 1) return null;
  const total = BigInt(price.minor) * BigInt(quantity);
  return total > BigInt(MONEY_MAX) ? null : Number(total);
}

/**
 * The fields of one purchase line (ADR-0099 §2): kind, description (the only thing a line needs),
 * quantity (default 1), unit price in the viewer's locale, and — on an asset line — the brand and model
 * as written on the document, an optional mapping to an asset model and the warranty; on a consumable line
 * (#1476) an optional mapping to the consumable it is received into; on a license line (#1477) an optional
 * mapping to the application its seats are for. Used by the create form's line editor, the edit-line dialog
 * and the extraction review.
 *
 * `annotations` add a line under a field (the extraction review's "read …" evidence or "not read"), and
 * `flagged` marks the fields the review asks the person to check.
 */
export function LineFields({
  line,
  index,
  onChange,
  errors,
  currency,
  autoFocus,
  onRemove,
  annotations,
  flagged,
}: {
  line: LineDraft;
  /** 1-based position, for accessible names. */
  index: number;
  onChange: (patch: Partial<LineDraft>) => void;
  errors?: LineErrors;
  /** The purchase's currency label, printed before the line total. */
  currency: string;
  autoFocus?: boolean;
  /** When set, a remove button ends the row. */
  onRemove?: () => void;
  /** A note under a field, keyed by the draft field (`assetModelId` for the model mapping). */
  annotations?: Partial<Record<keyof LineDraft, ReactNode>>;
  /** Fields to mark for checking. */
  flagged?: ReadonlySet<keyof LineDraft>;
}) {
  const t = useTranslations("purchases.line");
  const locale = useLocale();
  const id = (field: string) => `line-${line.key}-${field}`;
  const manufacturers = useSuggestions("manufacturer", line.manufacturerText, {
    enabled: line.kind === "ASSET",
  });
  const models = useSuggestions("lineModel", line.modelText, { enabled: line.kind === "ASSET" });
  // Descriptions already written on purchase lines (ADR-0099 §7, #1473) — the same item, spelled the same.
  const descriptions = useSuggestions("lineDescription", line.description);
  // Picking the consumable reads the consumables list; without that permission the line is still a
  // consumable line, mapped later by someone who can.
  const canReadConsumables = useCan("consumable:read");
  // Likewise the application of a license line (#1477): picked with `application:read`, else mapped later.
  const canReadApplications = useCan("application:read");
  const note = (field: keyof LineDraft) =>
    annotations?.[field] ? <div className="text-xs text-muted-foreground">{annotations[field]}</div> : null;
  const mark = (field: keyof LineDraft) => (flagged?.has(field) ? { "data-review-flag": "" } : {});
  const total = previewTotal(line, locale);
  const kinds: { value: PurchaseOrderLineKind; label: string }[] = [
    { value: "ASSET", label: t("kindAsset") },
    { value: "CONSUMABLE", label: t("kindConsumable") },
    { value: "LICENSE", label: t("kindLicense") },
    { value: "OTHER", label: t("kindOther") },
  ];

  return (
    <div className="space-y-3">
      {/* Four kinds do not fit a fixed column beside the description, so the row wraps. */}
      <div className="flex flex-wrap items-start gap-3">
        <Field className="group/field w-fit" {...mark("kind")}>
          <FieldLabel id={id("kind-label")}>{t("kind")}</FieldLabel>
          {isWritableKind(line.kind) ? (
            <SegmentedChoice
              id={id("kind")}
              value={line.kind}
              onValueChange={(kind) => onChange({ kind })}
              options={kinds}
              labelledBy={id("kind-label")}
            />
          ) : (
            // A kind a newer build wrote: shown as stored, never offered for change here.
            <Badge variant="outline" className="w-fit">
              {line.kind}
            </Badge>
          )}
          {note("kind")}
        </Field>
        <Field
          className="group/field min-w-60 flex-1"
          data-invalid={errors?.description ? true : undefined}
          {...mark("description")}
        >
          <FieldLabel htmlFor={id("description")}>{t("description")}</FieldLabel>
          <SuggestInput
            id={id("description")}
            value={line.description}
            onValueChange={(description) => onChange({ description })}
            source={() => descriptions}
            recentKey="purchase.lineDescription"
            placeholder={
              line.kind === "ASSET"
                ? t("descriptionPlaceholder")
                : line.kind === "CONSUMABLE"
                  ? t("descriptionConsumablePlaceholder")
                  : line.kind === "LICENSE"
                    ? t("descriptionLicensePlaceholder")
                    : t("descriptionOtherPlaceholder")
            }
            aria-invalid={errors?.description ? true : undefined}
            // A new row takes focus so the keyboard flow continues (Enter adds the next line).
            autoFocus={autoFocus}
          />
          {note("description")}
          {errors?.description ? <FieldError>{t("descriptionRequired")}</FieldError> : null}
        </Field>
      </div>

      {/* Three kinds do not fit beside the description and the amounts, so the amounts get their own row —
          shared with the consumable a consumable line is received into. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-start">
        <Field
          className="group/field sm:col-span-2"
          data-invalid={errors?.quantity ? true : undefined}
          {...mark("quantity")}
        >
          <FieldLabel htmlFor={id("quantity")}>{line.kind === "LICENSE" ? t("seats") : t("quantity")}</FieldLabel>
          <Input
            id={id("quantity")}
            inputMode="numeric"
            value={line.quantity}
            onChange={(event) => onChange({ quantity: event.target.value })}
            aria-invalid={errors?.quantity ? true : undefined}
            className="font-mono tabular-nums"
          />
          {note("quantity")}
          {errors?.quantity ? <FieldError>{t("quantityInvalid")}</FieldError> : null}
        </Field>
        <div className="group/field sm:col-span-3" {...mark("unitPrice")}>
          <MoneyField
            id={id("unitPrice")}
            label={t("unitPrice")}
            value={line.unitPrice}
            onValueChange={(unitPrice) => onChange({ unitPrice })}
            description={annotations?.unitPrice}
          />
        </div>
        {line.kind === "CONSUMABLE" && canReadConsumables ? (
          <Field className="sm:col-span-7">
            <FieldLabel htmlFor={id("consumable")}>{t("consumable")}</FieldLabel>
            <ConsumableCombobox
              id={id("consumable")}
              value={line.consumableId}
              onValueChange={(consumableId) => onChange({ consumableId })}
              allowOutOfStock
              placeholder={t("consumablePlaceholder")}
            />
            <FieldDescription>{t("consumableHelp")}</FieldDescription>
          </Field>
        ) : null}
        {line.kind === "LICENSE" && canReadApplications ? (
          <Field className="sm:col-span-7">
            <FieldLabel htmlFor={id("application")}>{t("application")}</FieldLabel>
            <ApplicationCombobox
              id={id("application")}
              value={line.applicationId}
              onValueChange={(applicationId) => onChange({ applicationId })}
              placeholder={t("applicationPlaceholder")}
            />
            <FieldDescription>{t("applicationHelp")}</FieldDescription>
          </Field>
        ) : null}
      </div>

      {line.kind === "ASSET" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-start">
          <Field className="group/field sm:col-span-3" {...mark("manufacturerText")}>
            <FieldLabel htmlFor={id("manufacturer")}>{t("manufacturer")}</FieldLabel>
            <SuggestInput
              id={id("manufacturer")}
              value={line.manufacturerText}
              onValueChange={(manufacturerText) => onChange({ manufacturerText })}
              source={() => manufacturers}
              recentKey="assetModel.manufacturer"
            />
            {note("manufacturerText")}
          </Field>
          <Field className="group/field sm:col-span-3" {...mark("modelText")}>
            <FieldLabel htmlFor={id("modelText")}>{t("modelText")}</FieldLabel>
            <SuggestInput
              id={id("modelText")}
              value={line.modelText}
              onValueChange={(modelText) => onChange({ modelText })}
              source={() => models}
              recentKey="purchase.lineModel"
            />
            {note("modelText")}
          </Field>
          <Field className="group/field sm:col-span-4" {...mark("assetModelId")}>
            <FieldLabel htmlFor={id("assetModel")}>{t("assetModel")}</FieldLabel>
            <AssetModelCombobox
              id={id("assetModel")}
              value={line.assetModelId}
              onValueChange={(assetModelId) => onChange({ assetModelId })}
              // Picking a model fills the brand and model text when they are still blank — never over
              // what the operator typed.
              onModelSelect={(model) =>
                onChange({
                  assetModelId: model.id,
                  manufacturerText: line.manufacturerText || model.manufacturer,
                  modelText: line.modelText || model.name,
                })
              }
              placeholder={t("assetModelPlaceholder")}
            />
            {note("assetModelId")}
          </Field>
          <Field
            className="group/field sm:col-span-2"
            data-invalid={errors?.warrantyMonths ? true : undefined}
            {...mark("warrantyMonths")}
          >
            <FieldLabel htmlFor={id("warranty")}>{t("warrantyMonths")}</FieldLabel>
            <Input
              id={id("warranty")}
              inputMode="numeric"
              value={line.warrantyMonths}
              onChange={(event) => onChange({ warrantyMonths: event.target.value })}
              aria-invalid={errors?.warrantyMonths ? true : undefined}
              className="font-mono tabular-nums"
            />
            {note("warrantyMonths")}
            {errors?.warrantyMonths ? <FieldError>{t("warrantyInvalid")}</FieldError> : null}
          </Field>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="font-mono tabular-nums">
          {total !== null ? t("lineTotal", { total: formatMoney(total, locale, currency) }) : null}
        </span>
        {onRemove ? (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
            <TrashIcon />
            {t("remove", { index })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
