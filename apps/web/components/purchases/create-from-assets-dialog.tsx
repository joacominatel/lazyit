"use client";

import { ArrowPathIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { useCreatePurchaseFromAssets } from "@/lib/api/hooks/use-purchase-orders";
import { useSuggestions } from "@/lib/api/hooks/use-suggestions";
import { notifyError } from "@/lib/api/notify-error";
import {
  buildFromAssetsPayload,
  fromAssetsOutcome,
  isNothingLinkable,
} from "@/lib/purchases/from-assets";
import type { FailureView } from "@/lib/purchases/link-apply";
import { runExclusive } from "@/lib/purchases/submit-guard";
import { SupplierField, useSupplierResolution, useSupplierSaver } from "@/app/(app)/purchases/_components/supplier-field";

/** One selected asset, as the Assets list row has it. */
export interface FromAssetsRef {
  id: string;
  name: string;
  assetTag: string | null;
}

/**
 * *Create purchase* from assets selected on the Assets list (ADR-0099 Phase 2, #1477) — the back-linking
 * helper for an estate bought before Purchases existed. A small header form (supplier, reference, currency
 * label, each optional and suggested by smart entry); the API makes one line per model (or name) and links
 * the assets, changing no other asset field. Everything linked → straight to the new purchase; assets left
 * out (archived, or already on another purchase) are listed with the reason, with the purchase one click
 * away. Gated by `purchaseOrder:write` + `asset:write`, as the route.
 */
export function CreatePurchaseFromAssetsDialog({
  assets,
  onClose,
  onCreated,
}: {
  assets: readonly FromAssetsRef[];
  onClose: () => void;
  /** Called once the purchase exists (the selection can be cleared). */
  onCreated?: () => void;
}) {
  const t = useTranslations("purchases.fromAssets");
  const tForm = useTranslations("purchases.form");
  const tc = useTranslations("common");
  const router = useRouter();
  const create = useCreatePurchaseFromAssets();
  const saveSupplier = useSupplierSaver();
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  const [supplierText, setSupplierText] = useState("");
  const [supplierChoice, setSupplierChoice] = useState("");
  const [supplierError, setSupplierError] = useState<string>();
  const [reference, setReference] = useState("");
  const [currency, setCurrency] = useState("");
  const [nothingLinkable, setNothingLinkable] = useState(false);
  const [result, setResult] = useState<{ id: string; linked: number; failures: FailureView[] } | null>(null);
  const { resolution, sameNamed } = useSupplierResolution(supplierText, null, supplierChoice);
  const references = useSuggestions("reference", reference);
  const currencies = useSuggestions("currency", currency);
  const [, rememberSupplier] = useRecentValues("purchase.supplier");
  const [, rememberReference] = useRecentValues("purchase.reference");
  const [, rememberCurrency] = useRecentValues("currency");

  async function save() {
    setSupplierError(undefined);
    setNothingLinkable(false);
    setSaving(true);
    try {
      const supplier = await saveSupplier(supplierText, supplierChoice);
      if (supplier === "ambiguous") {
        setSupplierError(tForm("supplierChooseError"));
        return;
      }
      if (supplier.created) toast.success(tForm("supplierCreatedToast", { name: supplier.created }));
      const built = buildFromAssetsPayload(
        assets.map((asset) => asset.id),
        supplier.id,
        { reference, currency },
      );
      if (!built.ok) return;
      const created = await create.mutateAsync(built.payload);
      rememberSupplier(supplierText);
      rememberReference(reference);
      rememberCurrency(currency);
      onCreated?.();
      const outcome = fromAssetsOutcome(created, new Map(assets.map((asset) => [asset.id, asset])));
      if (outcome.kind === "done") {
        toast.success(t("createdToast", { count: outcome.linked }));
        router.push(`/purchases/${created.purchaseOrder.id}`);
        return;
      }
      setResult({ id: created.purchaseOrder.id, linked: outcome.linked, failures: outcome.failures });
    } catch (error) {
      if (isNothingLinkable(error)) setNothingLinkable(true);
      else notifyError(error, t("error"));
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    void runExclusive(submitting, save);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {result ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("partialTitle")}</DialogTitle>
              <DialogDescription>{t("partialDescription", { count: result.linked })}</DialogDescription>
            </DialogHeader>
            <ul className="divide-y rounded-lg border text-sm">
              {result.failures.map((failure) => (
                <li key={failure.assetId} className="flex flex-wrap items-baseline gap-x-2 px-3 py-2">
                  <span className="font-medium">{failure.label}</span>
                  <span className="text-muted-foreground">
                    {failure.reasonKey ? t(`reasons.${failure.reasonKey}`) : failure.error}
                  </span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {tc("close")}
              </Button>
              <Button type="button" onClick={() => router.push(`/purchases/${result.id}`)}>
                {t("openPurchase")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("title", { count: assets.length })}</DialogTitle>
              <DialogDescription>{t("description")}</DialogDescription>
            </DialogHeader>
            <SupplierField
              id="from-assets-supplier"
              value={supplierText}
              onValueChange={(value) => {
                setSupplierText(value);
                setSupplierError(undefined);
              }}
              chosenId={supplierChoice}
              onChosenIdChange={(id) => {
                setSupplierChoice(id);
                setSupplierError(undefined);
              }}
              resolution={resolution}
              sameNamed={sameNamed}
              error={supplierError}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="from-assets-reference">{tForm("reference")}</FieldLabel>
                <SuggestInput
                  id="from-assets-reference"
                  value={reference}
                  onValueChange={setReference}
                  source={() => references}
                  recentKey="purchase.reference"
                  placeholder={tForm("referencePlaceholder")}
                  maxLength={200}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="from-assets-currency">{tForm("currency")}</FieldLabel>
                <SuggestInput
                  id="from-assets-currency"
                  value={currency}
                  onValueChange={setCurrency}
                  source={() => currencies}
                  recentKey="currency"
                  placeholder={tForm("currencyPlaceholder")}
                  maxLength={32}
                />
                <FieldDescription>{t("currencyHelp")}</FieldDescription>
              </Field>
            </div>
            <p className="text-sm text-muted-foreground">{t("linksOnly")}</p>
            {nothingLinkable ? (
              <Callout tone="warning" icon={<ExclamationTriangleIcon />} role="alert">
                <p className="text-sm">{t("nothingLinkable")}</p>
              </Callout>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                {tc("cancel")}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <ArrowPathIcon className="animate-spin" />}
                {t("submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
