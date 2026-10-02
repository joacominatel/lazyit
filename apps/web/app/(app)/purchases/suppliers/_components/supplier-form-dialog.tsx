"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateSupplierSchema, type Supplier } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect } from "react";
import { Controller, type Resolver, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
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
import { Field, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSuggestions } from "@/lib/api/hooks/use-suggestions";
import { useCreateSupplier, useSuppliers, useUpdateSupplier } from "@/lib/api/hooks/use-suppliers";
import { notifyError } from "@/lib/api/notify-error";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  type SupplierDraft,
  supplierDraftFrom,
  taxIdOwner,
  toCreateSupplier,
  toUpdateSupplier,
} from "@/lib/purchases/supplier";

const FORM_ID = "supplier-form";

type TextField = Exclude<keyof SupplierDraft, "name">;

/**
 * Create or edit a supplier (ADR-0099 §2): only the name is required, and nothing is unique. Another
 * spelling of an existing name gets a "use X instead?" hint, and a tax ID another supplier already holds
 * says whose it is — both suggestions, never refusals (CEO decision D-D).
 */
export function SupplierFormDialog({
  open,
  onOpenChange,
  supplier,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit it; absent → create. */
  supplier?: Supplier;
  onSaved?: (supplier: Supplier) => void;
}) {
  const t = useTranslations("purchases.suppliers.form");
  const tc = useTranslations("common");
  const createSupplier = useCreateSupplier();
  const updateSupplier = useUpdateSupplier();
  const pending = createSupplier.isPending || updateSupplier.isPending;
  const [, rememberSupplier] = useRecentValues("purchase.supplier");

  const form = useForm<SupplierDraft>({
    resolver: zodResolver(CreateSupplierSchema) as Resolver<SupplierDraft>,
    defaultValues: supplierDraftFrom(supplier),
  });
  useEffect(() => {
    if (open) form.reset(supplierDraftFrom(supplier));
  }, [open, supplier, form]);

  const name = useWatch({ control: form.control, name: "name" }) ?? "";
  const taxId = useWatch({ control: form.control, name: "taxId" }) ?? "";
  const names = useSuggestions("supplierName", name, { enabled: open });
  const typedTaxId = useDebouncedValue(taxId.trim(), 300);
  const { data: taxIdMatches } = useSuppliers(
    { q: typedTaxId, limit: 20 },
    { enabled: open && typedTaxId !== "" },
  );
  const owner =
    typedTaxId !== "" && typedTaxId === taxId.trim()
      ? taxIdOwner(typedTaxId, taxIdMatches?.items ?? [], supplier?.id)
      : null;

  const onSubmit = form.handleSubmit((values) => {
    const done = (saved: Supplier, message: string) => {
      rememberSupplier(saved.name);
      toast.success(message);
      onSaved?.(saved);
      onOpenChange(false);
    };
    if (supplier) {
      const payload = toUpdateSupplier(values, supplier);
      if (!payload) {
        onOpenChange(false);
        return;
      }
      updateSupplier.mutate(
        { id: supplier.id, data: payload },
        {
          onSuccess: (saved) => done(saved, t("savedToast")),
          onError: (error) => notifyError(error, t("saveError")),
        },
      );
      return;
    }
    createSupplier.mutate(toCreateSupplier(values), {
      onSuccess: (saved) => done(saved, t("createdToast")),
      onError: (error) => notifyError(error, t("createError")),
    });
  });

  const text = (field: TextField, label: string, opts: { type?: string; mono?: boolean } = {}) => (
    <Controller
      control={form.control}
      name={field}
      render={({ field: f, fieldState }) => (
        <Field data-invalid={fieldState.invalid || undefined}>
          <FieldLabel htmlFor={`supplier-${field}`}>{label}</FieldLabel>
          <Input
            id={`supplier-${field}`}
            type={opts.type ?? "text"}
            name={f.name}
            ref={f.ref}
            value={f.value ?? ""}
            onBlur={f.onBlur}
            onChange={(event) => f.onChange(event.target.value || undefined)}
            aria-invalid={fieldState.invalid || undefined}
            className={opts.mono ? "font-mono" : undefined}
          />
          <FieldError
            errors={[fieldState.error ? { message: t(`invalid.${field}`) } : undefined]}
          />
        </Field>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{supplier ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form
          id={FORM_ID}
          onSubmit={(event) => {
            event.stopPropagation();
            void onSubmit(event);
          }}
          noValidate
        >
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="name"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="supplier-name">{t("name")}</FieldLabel>
                    <SuggestInput
                      id="supplier-name"
                      value={field.value ?? ""}
                      onValueChange={field.onChange}
                      onBlur={field.onBlur}
                      source={() => names}
                      recentKey="purchase.supplier"
                      aria-invalid={fieldState.invalid || undefined}
                      autoFocus
                    />
                    <FieldError
                      errors={[fieldState.error ? { message: t("nameRequired") } : undefined]}
                    />
                  </Field>
                )}
              />
              <div className="space-y-1.5">
                {text("taxId", t("taxId"), { mono: true })}
                {owner ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    {t.rich("taxIdOwner", {
                      name: owner.name,
                      link: (chunks) => (
                        <Link
                          href={`/purchases/suppliers/${owner.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {chunks}
                        </Link>
                      ),
                    })}
                  </p>
                ) : null}
              </div>
              {text("website", t("website"))}
            </div>
            <FieldSet>
              <FieldLegend variant="label">{t("salesContact")}</FieldLegend>
              <div className="grid gap-4 sm:grid-cols-3">
                {text("salesContactName", t("contactName"))}
                {text("salesContactEmail", t("contactEmail"), { type: "email" })}
                {text("salesContactPhone", t("contactPhone"))}
              </div>
            </FieldSet>
            <FieldSet>
              <FieldLegend variant="label">{t("supportContact")}</FieldLegend>
              <div className="grid gap-4 sm:grid-cols-3">
                {text("supportContactName", t("contactName"))}
                {text("supportContactEmail", t("contactEmail"), { type: "email" })}
                {text("supportContactPhone", t("contactPhone"))}
              </div>
            </FieldSet>
            <Controller
              control={form.control}
              name="notes"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="supplier-notes">{t("notes")}</FieldLabel>
                  <Textarea
                    id="supplier-notes"
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value || undefined)}
                    rows={3}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error ? { message: t("invalid.notes") } : undefined]} />
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {tc("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={pending}>
            {pending && <ArrowPathIcon className="animate-spin" />}
            {supplier ? t("save") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
