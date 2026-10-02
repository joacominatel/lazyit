"use client";

import { ArrowPathIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import type { PurchaseOrderLine } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { ConsumableCombobox } from "@/components/consumable-combobox";
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
import { useConsumable } from "@/lib/api/hooks/use-consumables";
import { useReceiveStock, useUpdatePurchaseOrderLine } from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { buildStockReceivePayload, stockReceivePrefill, stockReceiveQuantity } from "@/lib/purchases/receive-stock";
import { usePurchaseTitle } from "@/app/(app)/purchases/_components/purchase-display";
import { overReceipt } from "@/app/(app)/assets/_components/receive-stock-payload";
import type { PurchaseTitleSource } from "@/lib/purchases/display";

/**
 * Whether the viewer may receive a consumable line into stock: the API needs `purchaseOrder:write` and
 * `consumable:write` (#1476).
 */
export function useCanReceiveStock(): boolean {
  const canWritePurchases = useCan("purchaseOrder:write");
  const canWriteConsumables = useCan("consumable:write");
  return canWritePurchases && canWriteConsumables;
}

/**
 * *Receive into stock* for a `CONSUMABLE` line (ADR-0099 Phase 1b, #1476): the count that arrived — prefilled
 * with the units still pending — and an optional note, posted as ONE `IN` movement on the line's consumable.
 * Receiving more than pending is allowed with a warning that offers to raise the line (§4). A line with no
 * consumable yet asks for one and saves it on the line first, so the next delivery already has it — the same
 * rule as an asset line without a model.
 *
 * The note lands on the consumable's movement ledger, which anyone who can see consumables reads (Viewers
 * included) — the field says so. Mounted only while open; gate it with {@link useCanReceiveStock}.
 */
export function ReceiveIntoStockDialog({
  purchase,
  line: initialLine,
  onClose,
}: {
  purchase: PurchaseTitleSource & { id: string };
  line: PurchaseOrderLine;
  onClose: () => void;
}) {
  const t = useTranslations("purchases.receiveStock");
  const tl = useTranslations("assets.receive.line");
  const tc = useTranslations("common");
  const titleOf = usePurchaseTitle();
  const canReadConsumables = useCan("consumable:read");
  const receive = useReceiveStock();
  const updateLine = useUpdatePurchaseOrderLine();
  const [line, setLine] = useState(initialLine);
  const [form, setForm] = useState(() => stockReceivePrefill(initialLine));
  const [consumableId, setConsumableId] = useState(initialLine.consumableId ?? "");
  const [errors, setErrors] = useState<{ quantity?: boolean; consumable?: boolean }>({});
  const { data: consumable } = useConsumable(canReadConsumables && consumableId ? consumableId : undefined);

  const unmapped = !line.consumableId;
  const quantity = stockReceiveQuantity(form.quantity);
  const over = quantity === null ? null : overReceipt(line, quantity);
  const pending = receive.isPending || updateLine.isPending;

  function raiseLine(to: number) {
    updateLine.mutate(
      { id: purchase.id, lineId: line.id, data: { quantity: to } },
      {
        onSuccess: (updated) => {
          toast.success(tl("raisedToast", { quantity: to }));
          setLine(updated);
        },
        onError: (error) => notifyError(error, tl("raiseError")),
      },
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const built = buildStockReceivePayload(form);
    const next = { quantity: !built.ok, consumable: unmapped && !consumableId };
    if (next.quantity || next.consumable) {
      setErrors(next);
      return;
    }
    if (!built.ok) return;
    let target = line;
    if (unmapped) {
      // Not a dead end: the consumable chosen here is saved on the line (logged), then the stock follows it.
      try {
        target = await updateLine.mutateAsync({ id: purchase.id, lineId: line.id, data: { consumableId } });
        setLine(target);
      } catch (error) {
        notifyError(error, t("consumableSaveError"));
        return;
      }
    }
    receive.mutate(
      { id: purchase.id, lineId: target.id, data: built.payload },
      {
        onSuccess: (result) => {
          toast.success(
            t("receivedToast", {
              count: result.movement.quantity,
              name: consumable?.name ?? target.description,
            }),
          );
          onClose();
        },
        onError: (error) => notifyError(error, t("error")),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {tl("description", {
                purchase: titleOf(purchase),
                line: line.description,
                pending: line.pendingQuantity,
              })}
            </DialogDescription>
          </DialogHeader>

          {unmapped ? (
            canReadConsumables ? (
              <Field data-invalid={errors.consumable || undefined}>
                <FieldLabel htmlFor="receive-stock-consumable" required>
                  {t("consumable")}
                </FieldLabel>
                <ConsumableCombobox
                  id="receive-stock-consumable"
                  value={consumableId}
                  onValueChange={(value) => {
                    setConsumableId(value);
                    setErrors((prev) => ({ ...prev, consumable: false }));
                  }}
                  ariaInvalid={errors.consumable}
                  allowOutOfStock
                  placeholder={t("consumablePlaceholder")}
                />
                <FieldDescription>{t("consumableMissing")}</FieldDescription>
                {errors.consumable ? <FieldError>{t("consumableRequired")}</FieldError> : null}
              </Field>
            ) : (
              <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
                <p className="text-sm">{t("consumableNoAccess")}</p>
              </Callout>
            )
          ) : consumable ? (
            <p className="text-sm">
              {t("into", { name: consumable.name, stock: consumable.currentStock, unit: consumable.unit })}
            </p>
          ) : null}

          <Field data-invalid={errors.quantity || undefined}>
            <FieldLabel htmlFor="receive-stock-quantity" required>
              {t("quantity")}
            </FieldLabel>
            <Input
              id="receive-stock-quantity"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={form.quantity}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, quantity: event.target.value }));
                setErrors((prev) => ({ ...prev, quantity: false }));
              }}
              aria-invalid={errors.quantity || undefined}
              className="font-mono tabular-nums"
              autoFocus={!unmapped}
            />
            <FieldDescription>{t("quantityHelp", { pending: line.pendingQuantity })}</FieldDescription>
            {errors.quantity ? <FieldError>{t("quantityInvalid")}</FieldError> : null}
          </Field>

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
                disabled={updateLine.isPending}
                onClick={() => raiseLine(over.raiseTo)}
              >
                {tl("raise", { quantity: over.raiseTo })}
              </Button>
            </Callout>
          ) : null}

          <Field>
            <FieldLabel htmlFor="receive-stock-note">{t("note")}</FieldLabel>
            <Textarea
              id="receive-stock-note"
              value={form.note}
              onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
              rows={2}
              maxLength={2000}
            />
            {/* The note is stored on the consumable's ledger, which Viewers can read (ADR-0099, #1476). */}
            <FieldDescription>{t("noteHelp")}</FieldDescription>
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <ArrowPathIcon className="animate-spin" />}
              {t("submit", { count: quantity ?? 0 })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
