"use client";

import { TrashIcon } from "@heroicons/react/24/outline";
import type { PurchaseOrderLineKind } from "@lazyit/shared";
import { Badge } from "@/components/ui/badge";
import { useLocale, useTranslations } from "next-intl";
import { AssetModelCombobox } from "@/components/asset-model-combobox";
import { MoneyField } from "@/components/money-input";
import { SuggestInput } from "@/components/suggest-input";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useSuggestions } from "@/lib/api/hooks/use-suggestions";
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
 * as written on the document, an optional mapping to an asset model and the warranty. Used by the create
 * form's line editor and the edit-line dialog.
 */
export function LineFields({
  line,
  index,
  onChange,
  errors,
  currency,
  autoFocus,
  onRemove,
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
}) {
  const t = useTranslations("purchases.line");
  const locale = useLocale();
  const id = (field: string) => `line-${line.key}-${field}`;
  const manufacturers = useSuggestions("manufacturer", line.manufacturerText, {
    enabled: line.kind === "ASSET",
  });
  const models = useSuggestions("lineModel", line.modelText, { enabled: line.kind === "ASSET" });
  const total = previewTotal(line, locale);
  const kinds: { value: PurchaseOrderLineKind; label: string }[] = [
    { value: "ASSET", label: t("kindAsset") },
    { value: "OTHER", label: t("kindOther") },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-start">
        <Field className="sm:col-span-2">
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
        </Field>
        <Field className="sm:col-span-5" data-invalid={errors?.description ? true : undefined}>
          <FieldLabel htmlFor={id("description")}>{t("description")}</FieldLabel>
          <Input
            id={id("description")}
            value={line.description}
            onChange={(event) => onChange({ description: event.target.value })}
            placeholder={line.kind === "ASSET" ? t("descriptionPlaceholder") : t("descriptionOtherPlaceholder")}
            aria-invalid={errors?.description ? true : undefined}
            // A new row takes focus so the keyboard flow continues (Enter adds the next line).
            autoFocus={autoFocus}
          />
          {errors?.description ? <FieldError>{t("descriptionRequired")}</FieldError> : null}
        </Field>
        <Field className="sm:col-span-2" data-invalid={errors?.quantity ? true : undefined}>
          <FieldLabel htmlFor={id("quantity")}>{t("quantity")}</FieldLabel>
          <Input
            id={id("quantity")}
            inputMode="numeric"
            value={line.quantity}
            onChange={(event) => onChange({ quantity: event.target.value })}
            aria-invalid={errors?.quantity ? true : undefined}
            className="font-mono tabular-nums"
          />
          {errors?.quantity ? <FieldError>{t("quantityInvalid")}</FieldError> : null}
        </Field>
        <div className="sm:col-span-3">
          <MoneyField
            id={id("unitPrice")}
            label={t("unitPrice")}
            value={line.unitPrice}
            onValueChange={(unitPrice) => onChange({ unitPrice })}
          />
        </div>
      </div>

      {line.kind === "ASSET" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-start">
          <Field className="sm:col-span-3">
            <FieldLabel htmlFor={id("manufacturer")}>{t("manufacturer")}</FieldLabel>
            <SuggestInput
              id={id("manufacturer")}
              value={line.manufacturerText}
              onValueChange={(manufacturerText) => onChange({ manufacturerText })}
              source={() => manufacturers}
              recentKey="assetModel.manufacturer"
            />
          </Field>
          <Field className="sm:col-span-3">
            <FieldLabel htmlFor={id("modelText")}>{t("modelText")}</FieldLabel>
            <SuggestInput
              id={id("modelText")}
              value={line.modelText}
              onValueChange={(modelText) => onChange({ modelText })}
              source={() => models}
              recentKey="purchase.lineModel"
            />
          </Field>
          <Field className="sm:col-span-4">
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
          </Field>
          <Field className="sm:col-span-2" data-invalid={errors?.warrantyMonths ? true : undefined}>
            <FieldLabel htmlFor={id("warranty")}>{t("warrantyMonths")}</FieldLabel>
            <Input
              id={id("warranty")}
              inputMode="numeric"
              value={line.warrantyMonths}
              onChange={(event) => onChange({ warrantyMonths: event.target.value })}
              aria-invalid={errors?.warrantyMonths ? true : undefined}
              className="font-mono tabular-nums"
            />
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
