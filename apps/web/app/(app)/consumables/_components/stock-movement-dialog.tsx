"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  type ConsumableMovementType,
  CreateConsumableMovementSchema,
} from "@lazyit/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, type Resolver, useForm, useWatch } from "react-hook-form";
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
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRecordMovement } from "@/lib/api/hooks/use-consumable-movement-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";

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

/**
 * Form schema — `type`/`consumableId` are supplied by props, so the form only validates the
 * quantity (whole number ≥ 1, matching the API's positive-int rule) and optional reason/notes.
 * Picked off the shared movement create schema so the int/positive constraint stays in one place.
 * `quantity` is held as a number (via the input's `valueAsNumber`), matching the canonical
 * numeric-field pattern in `consumable-form` and the schema's `int4` shape.
 */
const FormSchema = CreateConsumableMovementSchema.pick({
  quantity: true,
  reason: true,
  notes: true,
});
type FormValues = {
  quantity: number | undefined;
  reason?: string;
  notes?: string;
};

const FORM_ID = "stock-movement-form";

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
 * returns 409 if an OUT would go negative — surfaced as a toast (and pre-hinted inline). Converged
 * onto react-hook-form + zod + the `Field`/`FieldError`/`aria-invalid` contract (validation
 * onTouched; scroll-to-first-error on submit) — public props unchanged.
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
  const copy = COPY[type];

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema) as Resolver<FormValues>,
    mode: "onTouched",
    defaultValues: { quantity: undefined, reason: "", notes: "" },
  });

  // Reset whenever it reopens (or the direction changes), so a reused dialog starts clean.
  useEffect(() => {
    if (open) {
      form.reset({ quantity: undefined, reason: "", notes: "" });
    }
  }, [open, type, form]);

  const onSubmit = form.handleSubmit(
    (values) => {
      const trimmedReason = values.reason?.trim();
      const trimmedNotes = values.notes?.trim();
      record.mutate(
        {
          consumableId,
          data: {
            type,
            // The resolver (CreateConsumableMovementSchema's `quantity`) guarantees a positive int
            // here; the `?? 0` only satisfies the optional input-state type.
            quantity: values.quantity ?? 0,
            ...(trimmedReason ? { reason: trimmedReason } : {}),
            ...(trimmedNotes ? { notes: trimmedNotes } : {}),
          },
        },
        {
          onSuccess: () => {
            toast.success("Stock updated");
            onOpenChange(false);
          },
          onError: (error) => notifyError(error, "Couldn't update stock"),
        },
      );
    },
    (_errors, event) => scrollToFirstError(event?.target ?? null),
  );

  const watchedQty = useWatch({ control: form.control, name: "quantity" });
  // Soft inline hint — the API enforces this with a 409.
  const outExceeds =
    type === "OUT" &&
    typeof watchedQty === "number" &&
    Number.isFinite(watchedQty) &&
    watchedQty > currentStock;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            On hand now: {currentStock} {unit}.
          </DialogDescription>
        </DialogHeader>

        <form id={FORM_ID} onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Controller
              control={form.control}
              name="quantity"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="movement-qty" required>
                    {copy.quantityLabel}
                  </FieldLabel>
                  <Input
                    id="movement-qty"
                    type="number"
                    min={1}
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(event) =>
                      field.onChange(
                        event.target.value === ""
                          ? undefined
                          : event.target.valueAsNumber,
                      )
                    }
                    placeholder="1"
                    aria-invalid={fieldState.invalid || undefined}
                    autoFocus
                  />
                  <FieldDescription>{copy.quantityHint}</FieldDescription>
                  {outExceeds && (
                    <p className="text-sm text-destructive">
                      Only {currentStock} {unit} on hand — this will be rejected.
                    </p>
                  )}
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="reason"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="movement-reason">Reason</FieldLabel>
                  <Input
                    id="movement-reason"
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                    placeholder="Optional — e.g. restock, issued to Ada"
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="notes"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="movement-notes">Notes</FieldLabel>
                  <Textarea
                    id="movement-notes"
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                    rows={2}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={record.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} disabled={record.isPending}>
            {record.isPending && <ArrowPathIcon className="animate-spin" />}
            {copy.cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
