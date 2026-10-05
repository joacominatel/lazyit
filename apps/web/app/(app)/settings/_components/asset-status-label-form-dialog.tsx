"use client";

import { ArrowPathIcon, CheckIcon } from "@heroicons/react/24/outline";
import {
  type AssetStatus,
  type AssetStatusLabel,
  AssetStatusSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  AssetStatusSwatch,
  useAssetStatusLabel,
} from "@/app/(app)/assets/_components/asset-status-badge";
import { safeLabelColor } from "@/app/(app)/assets/_components/asset-status-options";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateAssetStatusLabel,
  useUpdateAssetStatusLabel,
} from "@/lib/api/hooks/use-asset-status-labels";
import { notifyError } from "@/lib/api/notify-error";
import { cn } from "@/lib/utils";
import {
  buildCreateStatusLabel,
  buildUpdateStatusLabel,
  STATUS_COLOR_PALETTE,
  type StatusLabelFormError,
  type StatusLabelFormValues,
  toStatusLabelFormValues,
} from "./asset-status-label-form";

const FORM_ID = "asset-status-label-form";

/**
 * Create / edit a custom asset status (ADR-0101): a name, the built-in status it maps to, an optional
 * colour, description and sort order. The built-in status is locked while any asset carries the custom
 * status (the API answers 409 — its assets would silently change status), and the dialog says so.
 *
 * The thin wrapper owns the `<Dialog>`; the body is keyed by the target so it remounts with fresh state
 * on every opening (the CategoryFormDialog pattern).
 */
export function AssetStatusLabelFormDialog({
  open,
  onOpenChange,
  label,
  defaultKind,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit it; absent → create. */
  label?: AssetStatusLabel;
  /** The built-in status a new custom status starts on (the group it was added from). */
  defaultKind?: AssetStatus;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <StatusLabelForm
            key={label ? `edit-${label.id}` : `new-${defaultKind ?? ""}`}
            label={label}
            defaultKind={defaultKind}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StatusLabelForm({
  label,
  defaultKind,
  onClose,
}: {
  label?: AssetStatusLabel;
  defaultKind?: AssetStatus;
  onClose: () => void;
}) {
  const t = useTranslations("settings.taxonomies.statuses");
  const tc = useTranslations("common");
  const statusLabel = useAssetStatusLabel();
  const create = useCreateAssetStatusLabel();
  const update = useUpdateAssetStatusLabel();
  const isEdit = label != null;
  const isPending = create.isPending || update.isPending;
  // The kind is frozen while assets carry the custom status (live ones counted here; archived ones are
  // caught by the API's 409, which the error toast reports).
  const inUse = (label?.assetCount ?? 0) > 0;

  const [values, setValues] = useState<StatusLabelFormValues>(() =>
    toStatusLabelFormValues(label, defaultKind),
  );
  const [error, setError] = useState<StatusLabelFormError | null>(null);

  function set<K extends keyof StatusLabelFormValues>(
    key: K,
    value: StatusLabelFormValues[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (label) {
      const built = buildUpdateStatusLabel(label, values);
      if (!built.ok) return setError(built.error);
      setError(null);
      if (!built.body) return onClose();
      update.mutate(
        { id: label.id, data: built.body },
        {
          onSuccess: (saved) => {
            toast.success(t("toast.updated", { name: saved.name }));
            onClose();
          },
          onError: (err) => notifyError(err, t("toast.updateError")),
        },
      );
      return;
    }
    const built = buildCreateStatusLabel(values);
    if (!built.ok) return setError(built.error);
    setError(null);
    create.mutate(built.body, {
      onSuccess: (saved) => {
        toast.success(t("toast.created", { name: saved.name }));
        onClose();
      },
      onError: (err) => notifyError(err, t("toast.createError")),
    });
  }

  const color = safeLabelColor(values.color.trim());

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEdit ? t("form.editTitle") : t("form.newTitle")}</DialogTitle>
        <DialogDescription>{t("form.description")}</DialogDescription>
      </DialogHeader>

      <form id={FORM_ID} onSubmit={handleSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={error === "nameRequired" || undefined}>
            <FieldLabel htmlFor="status-label-name">{t("form.nameLabel")}</FieldLabel>
            <Input
              id="status-label-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t("form.namePlaceholder")}
              maxLength={100}
              aria-invalid={error === "nameRequired" || undefined}
              autoFocus
            />
            {error === "nameRequired" ? (
              <FieldError errors={[{ message: t("form.errors.nameRequired") }]} />
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="status-label-kind">{t("form.kindLabel")}</FieldLabel>
            <Select
              value={values.kind}
              onValueChange={(value) => set("kind", value as AssetStatus)}
              disabled={inUse}
            >
              <SelectTrigger id="status-label-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AssetStatusSchema.options.map((status) => (
                  <SelectItem key={status} value={status}>
                    <span className="flex items-center gap-2">
                      <AssetStatusSwatch status={status} />
                      {statusLabel(status)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {inUse
                ? t("form.kindLocked", { count: label?.assetCount ?? 0 })
                : t("form.kindHelp")}
            </FieldDescription>
          </Field>

          <Field data-invalid={error === "colorInvalid" || undefined}>
            <FieldLabel htmlFor="status-label-color">{t("form.colorLabel")}</FieldLabel>
            <div
              role="radiogroup"
              aria-label={t("form.colorLabel")}
              className="flex flex-wrap items-center gap-1.5"
            >
              <SwatchButton
                selected={values.color.trim() === ""}
                onSelect={() => set("color", "")}
                label={t("form.colorDefault")}
              >
                <AssetStatusSwatch status={values.kind} className="size-2.5" />
              </SwatchButton>
              {STATUS_COLOR_PALETTE.map((swatch) => (
                <SwatchButton
                  key={swatch}
                  selected={values.color.trim().toUpperCase() === swatch}
                  onSelect={() => set("color", swatch)}
                  label={swatch}
                >
                  <span
                    aria-hidden="true"
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: swatch }}
                  />
                </SwatchButton>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="size-4 shrink-0 rounded-full border"
                style={color ? { backgroundColor: color } : undefined}
              />
              <Input
                id="status-label-color"
                value={values.color}
                onChange={(e) => set("color", e.target.value)}
                placeholder="#RRGGBB"
                maxLength={7}
                className="font-mono"
                aria-invalid={error === "colorInvalid" || undefined}
              />
            </div>
            <FieldDescription>{t("form.colorHelp")}</FieldDescription>
            {error === "colorInvalid" ? (
              <FieldError errors={[{ message: t("form.errors.colorInvalid") }]} />
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="status-label-description">
              {t("form.descriptionLabel")}
            </FieldLabel>
            <Textarea
              id="status-label-description"
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder={t("form.descriptionPlaceholder")}
              rows={2}
              maxLength={1000}
            />
          </Field>

          <Field data-invalid={error === "orderInvalid" || undefined}>
            <FieldLabel htmlFor="status-label-order">{t("form.orderLabel")}</FieldLabel>
            <Input
              id="status-label-order"
              type="number"
              inputMode="numeric"
              min={0}
              value={values.order}
              onChange={(e) => set("order", e.target.value)}
              placeholder={t("form.orderPlaceholder")}
              aria-invalid={error === "orderInvalid" || undefined}
            />
            {error === "orderInvalid" ? (
              <FieldError errors={[{ message: t("form.errors.orderInvalid") }]} />
            ) : null}
          </Field>
        </FieldGroup>
      </form>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
          {tc("cancel")}
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? t("form.save") : t("form.create")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** One colour choice: a round, labelled toggle with a check when selected. */
function SwatchButton({
  selected,
  onSelect,
  label,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={cn(
        "relative inline-flex size-7 items-center justify-center rounded-full border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-foreground" : "border-border hover:border-muted-foreground",
      )}
    >
      {children}
      {selected ? (
        <CheckIcon
          aria-hidden="true"
          className="absolute -right-1 -bottom-1 size-3.5 rounded-full bg-background p-0.5"
        />
      ) : null}
    </button>
  );
}
