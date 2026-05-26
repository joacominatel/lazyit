"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { ConsumableMovementType } from "@lazyit/shared";
import { useState } from "react";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRecordMovement } from "@/lib/api/hooks/use-consumable-movement-mutations";
import { notifyError } from "@/lib/api/notify-error";

const COPY: Record<
  ConsumableMovementType,
  { title: string; quantityLabel: string; quantityHint: string; cta: string }
> = {
  IN: {
    title: "Add stock",
    quantityLabel: "Quantity to add",
    quantityHint: "How many units are coming in.",
    cta: "Add stock",
  },
  OUT: {
    title: "Remove stock",
    quantityLabel: "Quantity to remove",
    quantityHint: "Cannot exceed what is on hand.",
    cta: "Remove stock",
  },
  ADJUSTMENT: {
    title: "Adjust stock",
    quantityLabel: "New stock count",
    quantityHint:
      "Sets on-hand to this exact number (a physical recount). Use 1 or more.",
    cta: "Set stock",
  },
};

interface StockMovementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consumableId: string;
  type: ConsumableMovementType;
  currentStock: number;
  unit: string;
}

/**
 * Record a stock movement. One dialog for all three directions (IN / OUT / ADJUSTMENT), driven by
 * `type`. Quantity is a positive integer; the API maintains `currentStock` transactionally and
 * returns 409 if an OUT would go negative — surfaced as a toast (and pre-hinted inline).
 */
export function StockMovementDialog({
  open,
  onOpenChange,
  consumableId,
  type,
  currentStock,
  unit,
}: StockMovementDialogProps) {
  const record = useRecordMovement();
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const copy = COPY[type];

  function handleOpenChange(next: boolean) {
    if (!next) {
      setQuantity("");
      setReason("");
      setNotes("");
    }
    onOpenChange(next);
  }

  function handleSubmit() {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      toast.error("Enter a whole quantity of 1 or more");
      return;
    }
    const trimmedReason = reason.trim();
    const trimmedNotes = notes.trim();
    record.mutate(
      {
        consumableId,
        data: {
          type,
          quantity: qty,
          ...(trimmedReason ? { reason: trimmedReason } : {}),
          ...(trimmedNotes ? { notes: trimmedNotes } : {}),
        },
      },
      {
        onSuccess: () => {
          toast.success("Stock updated");
          handleOpenChange(false);
        },
        onError: (error) =>
          notifyError(error, "Couldn't update stock"),
      },
    );
  }

  const qtyNum = Number(quantity);
  // Soft inline hint — the API enforces this with a 409.
  const outExceeds =
    type === "OUT" && Number.isFinite(qtyNum) && qtyNum > currentStock;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            On hand now: {currentStock} {unit}.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="movement-qty">{copy.quantityLabel}</FieldLabel>
            <Input
              id="movement-qty"
              type="number"
              min={1}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="1"
              autoFocus
            />
            <FieldDescription>{copy.quantityHint}</FieldDescription>
            {outExceeds && (
              <p className="text-sm text-destructive">
                Only {currentStock} {unit} on hand — this will be rejected.
              </p>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="movement-reason">Reason</FieldLabel>
            <Input
              id="movement-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional — e.g. restock, issued to Ada"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="movement-notes">Notes</FieldLabel>
            <Textarea
              id="movement-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
            />
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={record.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={record.isPending}
          >
            {record.isPending && <ArrowPathIcon className="animate-spin" />}
            {copy.cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
