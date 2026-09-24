"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
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
import { useConsumable } from "@/lib/api/hooks/use-consumables";
import { notifyError } from "@/lib/api/notify-error";
import {
  buildMovementPayload,
  type DeliveryTargetRef,
} from "@/lib/consumables/deliveries";
import {
  issuesResolver,
  type MovementFieldIssue,
  movementPayloadIssues,
} from "@/lib/consumables/movement-form";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";

type FormValues = {
  consumableId: string;
  quantity: number | undefined;
  notes: string;
};

const EMPTY_VALUES: FormValues = { consumableId: "", quantity: undefined, notes: "" };

const FORM_ID = "deliver-consumable-form";

/**
 * Deliver a consumable to the person / asset / location whose page this is (ADR-0098): pick a live
 * consumable, a quantity and optional notes, and record an `OUT` movement with the target preset. It is
 * the same ledger write as the consumable's own Remove dialog with a recipient — just started from the
 * recipient's side. On-hand is hinted inline; the API still enforces it (409).
 */
export function DeliverConsumableDialog({
  target,
  targetName,
  open,
  onOpenChange,
}: {
  target: DeliveryTargetRef;
  /** Display name of the recipient, for the dialog copy. */
  targetName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("consumables.deliveries.deliverDialog");
  const tc = useTranslations("common");
  const record = useRecordMovement();

  const resolver = useMemo(
    () =>
      issuesResolver<FormValues>((values) => {
        const issues: Record<string, MovementFieldIssue> = {};
        if (!values.consumableId) {
          issues.consumableId = { type: "required", message: t("consumableRequired") };
        }
        const payloadIssues = movementPayloadIssues(
          buildMovementPayload({
            type: "OUT",
            quantity: values.quantity as number,
            notes: values.notes,
            target,
          }),
        );
        if (payloadIssues.quantity) issues.quantity = payloadIssues.quantity;
        if (payloadIssues.notes) issues.notes = payloadIssues.notes;
        return issues;
      }),
    [target, t],
  );

  const form = useForm<FormValues>({
    resolver,
    mode: "onTouched",
    defaultValues: EMPTY_VALUES,
  });

  useEffect(() => {
    if (open) form.reset(EMPTY_VALUES);
  }, [open, form]);

  const consumableId = useWatch({ control: form.control, name: "consumableId" });
  const quantity = useWatch({ control: form.control, name: "quantity" });
  // The picked consumable (already cached by the picker) — for the on-hand hint and the returnable note.
  const { data: consumable } = useConsumable(consumableId || undefined);
  const exceeds =
    consumable != null &&
    typeof quantity === "number" &&
    Number.isFinite(quantity) &&
    quantity > consumable.currentStock;

  const onSubmit = form.handleSubmit(
    (values) => {
      record.mutate(
        {
          consumableId: values.consumableId,
          data: buildMovementPayload({
            type: "OUT",
            quantity: values.quantity ?? 0,
            notes: values.notes,
            target,
          }),
        },
        {
          onSuccess: () => {
            toast.success(t("successToast", { name: targetName }));
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
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { name: targetName })}</DialogDescription>
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
              name="consumableId"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="deliver-consumable" required>
                    {t("consumableLabel")}
                  </FieldLabel>
                  <ConsumableCombobox
                    id="deliver-consumable"
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      if (value) form.clearErrors("consumableId");
                    }}
                    ariaInvalid={fieldState.invalid || undefined}
                    disabled={record.isPending}
                    placeholder={t("consumablePlaceholder")}
                    searchPlaceholder={t("consumableSearch")}
                    emptyText={t("consumableEmpty")}
                  />
                  {consumable ? (
                    <FieldDescription>
                      {consumable.returnable
                        ? t("onHandReturnable", {
                            count: consumable.currentStock,
                            unit: consumable.unit,
                          })
                        : t("onHand", {
                            count: consumable.currentStock,
                            unit: consumable.unit,
                          })}
                    </FieldDescription>
                  ) : null}
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="quantity"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="deliver-qty" required>
                    {t("quantityLabel")}
                  </FieldLabel>
                  <Input
                    id="deliver-qty"
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
                  />
                  {exceeds && consumable ? (
                    <p className="text-sm text-destructive">
                      {t("exceeds", {
                        count: consumable.currentStock,
                        unit: consumable.unit,
                      })}
                    </p>
                  ) : null}
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="notes"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="deliver-notes">{t("notesLabel")}</FieldLabel>
                  <Textarea
                    id="deliver-notes"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
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
