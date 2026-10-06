"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { CancelRemainingUnitsSchema, type PurchaseOrderLine } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCancelRemainingUnits } from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";

/**
 * "Cancel remaining units" on a line (ADR-0099 §3): units that will not arrive. The quantity defaults to
 * every pending unit and cannot exceed them; the reason is optional (D-D) and goes to the purchase's
 * activity log. The line then reads "3 received · 1 cancelled" and leaves the Pending units view.
 * Mounted only while open; gate it with `purchaseOrder:write`.
 */
export function CancelRemainingDialog({
  purchaseId,
  line,
  onClose,
}: {
  purchaseId: string;
  line: PurchaseOrderLine;
  onClose: () => void;
}) {
  const t = useTranslations("purchases.cancelRemaining");
  const tc = useTranslations("common");
  const cancel = useCancelRemainingUnits();
  const [quantity, setQuantity] = useState(String(line.pendingQuantity));
  const [reason, setReason] = useState("");
  const [quantityError, setQuantityError] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const count = Number(quantity);
    const parsed = CancelRemainingUnitsSchema.safeParse({ quantity: count, reason });
    if (!parsed.success || count > line.pendingQuantity) {
      setQuantityError(true);
      return;
    }
    cancel.mutate(
      { id: purchaseId, lineId: line.id, data: parsed.data },
      {
        onSuccess: () => {
          toast.success(t("cancelledToast", { count }));
          onClose();
        },
        onError: (error) => notifyError(error, t("error")),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {t("description", { line: line.description, pending: line.pendingQuantity })}
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={quantityError || undefined}>
            <FieldLabel htmlFor="cancel-remaining-quantity">{t("quantity")}</FieldLabel>
            <Input
              id="cancel-remaining-quantity"
              type="number"
              inputMode="numeric"
              min="1"
              max={line.pendingQuantity}
              step="1"
              value={quantity}
              onChange={(event) => {
                setQuantity(event.target.value);
                setQuantityError(false);
              }}
              aria-invalid={quantityError || undefined}
              className="font-mono tabular-nums"
            />
            {quantityError ? (
              <FieldError>{t("quantityInvalid", { pending: line.pendingQuantity })}</FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="cancel-remaining-reason">{t("reason")}</FieldLabel>
            <Textarea
              id="cancel-remaining-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              maxLength={500}
              placeholder={t("reasonPlaceholder")}
            />
            <FieldDescription>{t("reasonHelp")}</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={cancel.isPending}>
              {tc("cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={cancel.isPending}>
              {cancel.isPending && <ArrowPathIcon className="animate-spin" />}
              {t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
