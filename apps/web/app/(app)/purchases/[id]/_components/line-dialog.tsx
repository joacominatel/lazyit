"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { PurchaseOrderLine } from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { useRecentValues } from "@/components/suggest-input";
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
  useAddPurchaseOrderLine,
  useUpdatePurchaseOrderLine,
} from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import {
  emptyLineDraft,
  type LineDraft,
  type LineErrors,
  lineDraftFrom,
  toCreateLine,
  toUpdateLine,
} from "@/lib/purchases/payload";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";
import { LineFields } from "../../_components/line-fields";

/**
 * Add a line to a saved purchase, or edit one (ADR-0099 §2). Only the description is required. Editing
 * sends only what changed; a line with linked units keeps its kind (the API refuses the change, 409).
 */
export function LineDialog({
  open,
  onOpenChange,
  purchaseId,
  currency,
  line,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchaseId: string;
  currency: string;
  /** Present → edit this line; absent → add a new one. */
  line?: PurchaseOrderLine;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        {open ? (
          <LineDialogBody
            purchaseId={purchaseId}
            currency={currency}
            line={line}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function LineDialogBody({
  purchaseId,
  currency,
  line,
  onDone,
}: {
  purchaseId: string;
  currency: string;
  line?: PurchaseOrderLine;
  onDone: () => void;
}) {
  const t = useTranslations("purchases.lineDialog");
  const tc = useTranslations("common");
  const locale = useLocale();
  const addLine = useAddPurchaseOrderLine();
  const updateLine = useUpdatePurchaseOrderLine();
  const [, rememberManufacturer] = useRecentValues("assetModel.manufacturer");
  const [, rememberLineModel] = useRecentValues("purchase.lineModel");
  const [draft, setDraft] = useState<LineDraft>(() =>
    line ? lineDraftFrom(line, locale) : emptyLineDraft("new"),
  );
  const [errors, setErrors] = useState<LineErrors>({});
  const pending = addLine.isPending || updateLine.isPending;

  function saved() {
    rememberManufacturer(draft.manufacturerText);
    rememberLineModel(draft.modelText);
    toast.success(line ? t("savedToast") : t("addedToast"));
    onDone();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const form = event.currentTarget;
    if (line) {
      const result = toUpdateLine(draft, line, locale);
      if (!result.ok) {
        setErrors(result.errors);
        scrollToFirstError(form);
        return;
      }
      if (!result.payload) {
        onDone();
        return;
      }
      updateLine.mutate(
        { id: purchaseId, lineId: line.id, data: result.payload },
        { onSuccess: saved, onError: (error) => notifyError(error, t("saveError")) },
      );
      return;
    }
    const result = toCreateLine(draft, locale);
    if (!result.ok) {
      setErrors(result.errors);
      scrollToFirstError(form);
      return;
    }
    addLine.mutate(
      { id: purchaseId, data: result.line },
      { onSuccess: saved, onError: (error) => notifyError(error, t("addError")) },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <DialogHeader>
        <DialogTitle>{line ? t("editTitle") : t("addTitle")}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>
      <LineFields
        line={draft}
        index={line ? line.position + 1 : 1}
        onChange={(patch) => {
          setDraft((prev) => ({ ...prev, ...patch }));
          setErrors({});
        }}
        errors={errors}
        currency={currency}
        autoFocus
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          {tc("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <ArrowPathIcon className="animate-spin" />}
          {line ? t("save") : t("add")}
        </Button>
      </DialogFooter>
    </form>
  );
}
