"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { ConsumableDelivery } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
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
import { buildReturnPayload } from "@/lib/consumables/deliveries";
import {
  issuesResolver,
  type MovementFieldIssue,
  movementPayloadIssues,
} from "@/lib/consumables/movement-form";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";

type FormValues = { quantity: number | undefined; notes: string };

const FORM_ID = "return-delivery-form";

/**
 * Record a RETURN against one returnable delivery (ADR-0098): an `IN` movement linked to it by
 * `returnOfId`, so the units go back on the shelf and the delivery's outstanding count drops. Partial
 * returns are allowed; the quantity defaults to everything still out and is capped at it (the API also
 * refuses an over-return with a 409, e.g. when someone else returned units in the meantime).
 */
export function ReturnDeliveryDialog({
  delivery,
  open,
  onOpenChange,
}: {
  /** The delivery being returned; the dialog renders nothing without one. */
  delivery: ConsumableDelivery | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("consumables.deliveries.returnDialog");
  const tc = useTranslations("common");
  const record = useRecordMovement();
  const outstanding = delivery?.outstandingQuantity ?? 0;

  const resolver = useMemo(
    () =>
      issuesResolver<FormValues>((values) => {
        const issues: Record<string, MovementFieldIssue> = {};
        const payloadIssues = movementPayloadIssues(
          buildReturnPayload({
            deliveryId: delivery?.id ?? 0,
            quantity: values.quantity as number,
            notes: values.notes,
          }),
        );
        if (payloadIssues.quantity) issues.quantity = payloadIssues.quantity;
        if (payloadIssues.notes) issues.notes = payloadIssues.notes;
        if (
          !issues.quantity &&
          typeof values.quantity === "number" &&
          values.quantity > outstanding
        ) {
          issues.quantity = {
            type: "too_big",
            message: t("tooMany", { count: outstanding }),
          };
        }
        return issues;
      }),
    [delivery?.id, outstanding, t],
  );

  const form = useForm<FormValues>({
    resolver,
    mode: "onTouched",
    defaultValues: { quantity: outstanding || undefined, notes: "" },
  });

  // Each open starts from "return everything still out".
  useEffect(() => {
    if (open) form.reset({ quantity: outstanding || undefined, notes: "" });
  }, [open, outstanding, form]);

  if (!delivery) return null;

  const onSubmit = form.handleSubmit(
    (values) => {
      record.mutate(
        {
          consumableId: delivery.consumableId,
          data: buildReturnPayload({
            deliveryId: delivery.id,
            quantity: values.quantity ?? 0,
            notes: values.notes,
          }),
        },
        {
          onSuccess: () => {
            toast.success(t("successToast"));
            onOpenChange(false);
          },
          onError: (error) => notifyError(error, t("errorToast")),
        },
      );
    },
    (_errors, event) => scrollToFirstError(event?.target ?? null),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title", { name: delivery.consumable.name })}</DialogTitle>
          <DialogDescription>
            {t("description", {
              outstanding,
              quantity: delivery.quantity,
              unit: delivery.consumable.unit,
            })}
          </DialogDescription>
        </DialogHeader>

        <form
          id={FORM_ID}
          onSubmit={(e) => {
            e.stopPropagation();
            onSubmit(e);
          }}
          noValidate
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="quantity"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="return-qty" required>
                    {t("quantityLabel")}
                  </FieldLabel>
                  <Input
                    id="return-qty"
                    type="number"
                    min={1}
                    max={outstanding}
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
                    aria-invalid={fieldState.invalid || undefined}
                    autoFocus
                  />
                  <FieldDescription>{t("quantityHint")}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="notes"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="return-notes">{t("notesLabel")}</FieldLabel>
                  <Textarea
                    id="return-notes"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                    rows={2}
                    placeholder={t("notesPlaceholder")}
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
            {tc("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={record.isPending}>
            {record.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("cta")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
