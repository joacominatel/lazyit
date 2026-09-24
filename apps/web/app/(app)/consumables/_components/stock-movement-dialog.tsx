"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { ConsumableMovementType } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
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
import {
  type DeliveryTargetChoice,
  DeliveryTargetField,
} from "./delivery-target-field";

/** Movement direction → its i18n subkey under `consumables.stock.dialog`. */
const COPY_KEY: Record<ConsumableMovementType, "in" | "out" | "adjustment"> = {
  IN: "in",
  OUT: "out",
  ADJUSTMENT: "adjustment",
};

/**
 * Form state. `type`/`consumableId` come from props. `targetKind`/`targetId` are the optional "Deliver
 * to" of a Remove (ADR-0098) — ignored for Add / Adjust. `quantity` is held as a number (via the input's
 * `valueAsNumber`), matching the canonical numeric-field pattern in `consumable-form`.
 *
 * Validation runs on the payload the dialog will actually SEND (`buildMovementPayload` →
 * `CreateConsumableMovementSchema`), not on a `.pick()` of the schema: the create schema is refined
 * (one target, only on an OUT), and zod refuses `.pick()` on a refined object. So the int/positive
 * quantity rule and the target rules stay in the one shared place.
 */
type FormValues = {
  quantity: number | undefined;
  reason?: string;
  notes?: string;
  targetKind: DeliveryTargetChoice;
  targetId: string;
};

const EMPTY_VALUES: FormValues = {
  quantity: undefined,
  reason: "",
  notes: "",
  targetKind: "none",
  targetId: "",
};

/** The chosen destination, or null for "nobody". */
function targetOf(values: FormValues): DeliveryTargetRef | null {
  return values.targetKind === "none"
    ? null
    : { kind: values.targetKind, id: values.targetId };
}

const FORM_ID = "stock-movement-form";

interface StockMovementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consumableId: string;
  type: ConsumableMovementType;
  currentStock: number;
  unit: string;
  /**
   * Whether the consumable is returnable (ADR-0098) — a Remove that names a recipient then hints that
   * the units are expected back. Absent on an older read → false.
   */
  returnable?: boolean;
}

/**
 * Record a stock movement. One dialog for all three directions (IN / OUT / ADJUSTMENT), driven by
 * `type`. A Remove may optionally name ONE recipient — a person, an asset or a location — which makes
 * it a delivery (ADR-0098). Quantity is a positive integer; the API maintains `currentStock` transactionally and
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
  returnable = false,
}: StockMovementDialogProps) {
  const t = useTranslations("consumables");
  const tc = useTranslations("common");
  const record = useRecordMovement();
  const copyKey = COPY_KEY[type];

  // Validate the payload that will be sent; payload keys map 1:1 to form fields except the three
  // target keys, which all land on the single `targetId` picker. A kind chosen with nothing picked is
  // reported there too (the builder would otherwise silently send a plain removal).
  const resolver = useMemo(
    () =>
      issuesResolver<FormValues>((values) => {
        const issues: Record<string, MovementFieldIssue> = {};
        const payloadIssues = movementPayloadIssues(
          buildMovementPayload({
            type,
            quantity: values.quantity as number,
            reason: values.reason,
            notes: values.notes,
            target: targetOf(values),
          }),
        );
        for (const [key, issue] of Object.entries(payloadIssues)) {
          const field = key.startsWith("target") ? "targetId" : key;
          issues[field] ??= issue;
        }
        if (type === "OUT" && values.targetKind !== "none" && !values.targetId) {
          issues.targetId ??= {
            type: "required",
            message: t(`stock.dialog.target.required.${values.targetKind}`),
          };
        }
        return issues;
      }),
    [type, t],
  );

  const form = useForm<FormValues>({
    resolver,
    mode: "onTouched",
    defaultValues: EMPTY_VALUES,
  });

  // Reset whenever it reopens (or the direction changes), so a reused dialog starts clean.
  useEffect(() => {
    if (open) {
      form.reset(EMPTY_VALUES);
    }
  }, [open, type, form]);

  const onSubmit = form.handleSubmit(
    (values) => {
      const data = buildMovementPayload({
        type,
        // The resolver guarantees a positive int here; the `?? 0` only satisfies the input-state type.
        quantity: values.quantity ?? 0,
        reason: values.reason,
        notes: values.notes,
        target: targetOf(values),
      });
      record.mutate(
        { consumableId, data },
        {
          onSuccess: () => {
            toast.success(
              type === "OUT" && values.targetKind !== "none"
                ? t("stock.dialog.deliveredToast")
                : t("stock.dialog.updatedToast"),
            );
            onOpenChange(false);
          },
          onError: (error) => notifyError(error, t("stock.dialog.updateError")),
        },
      );
    },
    (_errors, event) => scrollToFirstError(event?.target ?? null),
  );

  const watchedQty = useWatch({ control: form.control, name: "quantity" });
  const watchedKind = useWatch({ control: form.control, name: "targetKind" });
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
          <DialogTitle>{t(`stock.dialog.${copyKey}.title`)}</DialogTitle>
          <DialogDescription>
            {t("stock.dialog.onHand", { count: currentStock, unit })}
          </DialogDescription>
        </DialogHeader>

        {/* stopPropagation: a form inside a Radix Portal still bubbles its submit through the React
            tree to any ancestor form, so guard it defensively (issue #164). */}
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
                  <FieldLabel htmlFor="movement-qty" required>
                    {t(`stock.dialog.${copyKey}.quantityLabel`)}
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
                  <FieldDescription>
                    {t(`stock.dialog.${copyKey}.quantityHint`)}
                  </FieldDescription>
                  {outExceeds && (
                    <p className="text-sm text-destructive">
                      {t("stock.dialog.outExceeds", {
                        count: currentStock,
                        unit,
                      })}
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
                  <FieldLabel htmlFor="movement-reason">
                    {t("stock.dialog.reasonLabel")}
                  </FieldLabel>
                  <Input
                    id="movement-reason"
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                    placeholder={t("stock.dialog.reasonPlaceholder")}
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
                  <FieldLabel htmlFor="movement-notes">
                    {t("stock.dialog.notesLabel")}
                  </FieldLabel>
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

            {/* Deliver to (ADR-0098) — only on the detailed Remove. Optional: "Nobody" (the default)
                records a plain removal exactly as before. The quick −1/+1 never sends a target. */}
            {type === "OUT" ? (
              <Controller
                control={form.control}
                name="targetId"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="movement-target-kind">
                      {t("stock.dialog.target.label")}
                    </FieldLabel>
                    <DeliveryTargetField
                      kind={watchedKind}
                      onKindChange={(kind) => {
                        form.setValue("targetKind", kind);
                        // A new kind needs a new pick; clear any stale id and its error.
                        field.onChange("");
                        form.clearErrors("targetId");
                      }}
                      targetId={field.value}
                      onTargetIdChange={(id) => {
                        field.onChange(id);
                        if (id) form.clearErrors("targetId");
                      }}
                      targetError={fieldState.error?.message}
                      disabled={record.isPending}
                    />
                    <FieldDescription>
                      {watchedKind === "none"
                        ? t("stock.dialog.target.hint")
                        : returnable
                          ? t("stock.dialog.target.returnableHint")
                          : t("stock.dialog.target.consumedHint")}
                    </FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            ) : null}
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
            {t(`stock.dialog.${copyKey}.cta`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
