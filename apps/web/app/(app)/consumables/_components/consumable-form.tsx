"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  cloneConsumableDefaults,
  type Consumable,
  CreateConsumableSchema,
  UpdateConsumableSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Controller, type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
import { CategoryCombobox } from "@/components/category-combobox";
import { CreatableField } from "@/components/creatable-field";
import { CreateCategoryDialog } from "@/components/create-category-dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConsumableCategories } from "@/lib/api/hooks/use-consumable-categories";
import {
  useCreateConsumable,
  useUpdateConsumable,
} from "@/lib/api/hooks/use-consumable-mutations";
import { notifyError } from "@/lib/api/notify-error";

const FORM_ID = "consumable-form";

type ConsumableFormValues = {
  name: string;
  sku?: string;
  categoryId?: string;
  description?: string;
  minStock?: number;
  unit: string;
  notes?: string;
};

/**
 * Initial form values. Edit → from the persisted `consumable`. Clone → from the shared
 * `cloneConsumableDefaults` sanitizer (CREATE mode, unique `sku` cleared, " (copy)" name). Otherwise
 * the blank create defaults.
 */
function toFormValues(
  consumable?: Consumable,
  cloneSource?: Consumable,
): ConsumableFormValues {
  if (consumable) {
    return {
      name: consumable.name,
      sku: consumable.sku ?? undefined,
      categoryId: consumable.categoryId ?? undefined,
      description: consumable.description ?? undefined,
      minStock: consumable.minStock ?? undefined,
      unit: consumable.unit,
      notes: consumable.notes ?? undefined,
    };
  }
  if (cloneSource) {
    const d = cloneConsumableDefaults(cloneSource);
    return {
      name: d.name ?? "",
      // sku is cleared by the sanitizer → render empty.
      sku: d.sku,
      categoryId: d.categoryId,
      description: d.description,
      minStock: d.minStock,
      unit: d.unit ?? "units",
      notes: d.notes,
    };
  }
  return { name: "", unit: "units" };
}

/**
 * Create/edit/clone form for a Consumable. Per-mode validation (CreateConsumableSchema vs the partial
 * UpdateConsumableSchema — ADR-0020). Clone (`cloneSource`, no `consumable`) stays in CREATE mode but
 * pre-fills from the shared `cloneConsumableDefaults` sanitizer (issue #125): name " (copy)" and the
 * unique `sku` cleared. `currentStock` is intentionally absent: it starts at 0 and only changes
 * through stock movements (ADR-0034), never this form — so it is never cloned either.
 */
export function ConsumableForm({
  consumable,
  cloneSource,
}: {
  consumable?: Consumable;
  /** When set (and `consumable` is not), pre-fill a CREATE form from this record — see issue #125. */
  cloneSource?: Consumable;
}) {
  const t = useTranslations("consumables");
  const tc = useTranslations("common");
  const isEdit = consumable != null;
  const router = useRouter();
  const { data: categories } = useConsumableCategories();
  const createConsumable = useCreateConsumable();
  const updateConsumable = useUpdateConsumable();
  const isPending = createConsumable.isPending || updateConsumable.isPending;

  const form = useForm<ConsumableFormValues>({
    resolver: zodResolver(
      isEdit ? UpdateConsumableSchema : CreateConsumableSchema,
    ) as Resolver<ConsumableFormValues>,
    defaultValues: toFormValues(consumable, cloneSource),
  });

  const onSubmit = form.handleSubmit((values) => {
    const payload = {
      name: values.name,
      sku: values.sku,
      categoryId: values.categoryId,
      description: values.description,
      minStock: values.minStock,
      unit: values.unit,
      notes: values.notes,
    };

    if (consumable) {
      updateConsumable.mutate(
        { id: consumable.id, data: payload },
        {
          onSuccess: (updated) => {
            toast.success(t("form.savedToast"));
            router.push(`/consumables/${updated.id}`);
          },
          onError: (error) =>
            notifyError(error, t("form.saveError")),
        },
      );
    } else {
      createConsumable.mutate(payload, {
        onSuccess: (created) => {
          toast.success(t("form.createdToast"));
          router.push(`/consumables/${created.id}`);
        },
        onError: (error) =>
          notifyError(error, t("form.createError")),
      });
    }
  });

  return (
    <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-6">
      <FieldGroup>
        <Controller
          control={form.control}
          name="name"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="name">{t("form.nameLabel")}</FieldLabel>
              <Input
                {...field}
                id="name"
                value={field.value ?? ""}
                placeholder={t("form.namePlaceholder")}
                aria-invalid={fieldState.invalid || undefined}
                autoFocus
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Controller
            control={form.control}
            name="sku"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="sku">{t("form.skuLabel")}</FieldLabel>
                <Input
                  id="sku"
                  name={field.name}
                  ref={field.ref}
                  value={field.value ?? ""}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(event.target.value || undefined)
                  }
                  placeholder={t("form.skuPlaceholder")}
                  className="font-mono"
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="categoryId"
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="categoryId">
                  {t("form.categoryLabel")}
                </FieldLabel>
                <CreatableField
                  label="category"
                  renderDialog={(dialog) => (
                    <CreateCategoryDialog
                      kind="consumable"
                      open={dialog.open}
                      onOpenChange={dialog.onOpenChange}
                      onCreated={(category) => field.onChange(category.id)}
                    />
                  )}
                >
                  <CategoryCombobox
                    id="categoryId"
                    value={field.value ?? ""}
                    onValueChange={(value) =>
                      field.onChange(value === "" ? undefined : value)
                    }
                    categories={categories ?? []}
                    placeholder={t("form.categoryPlaceholder")}
                    searchPlaceholder={t("form.searchCategory")}
                    emptyText={t("form.noCategories")}
                  />
                </CreatableField>
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="minStock"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="minStock">
                  {t("form.reorderThresholdLabel")}
                </FieldLabel>
                <Input
                  id="minStock"
                  type="number"
                  min={0}
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
                  placeholder={t("form.reorderThresholdPlaceholder")}
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldDescription>
                  {t("form.reorderThresholdHint")}
                </FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="unit"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="unit">{t("form.unitLabel")}</FieldLabel>
                <Input
                  {...field}
                  id="unit"
                  value={field.value ?? ""}
                  placeholder={t("form.unitPlaceholder")}
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldDescription>{t("form.unitHint")}</FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>

        <Controller
          control={form.control}
          name="description"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="description">
                {t("form.descriptionLabel")}
              </FieldLabel>
              <Textarea
                id="description"
                name={field.name}
                ref={field.ref}
                value={field.value ?? ""}
                onBlur={field.onBlur}
                onChange={(event) =>
                  field.onChange(event.target.value || undefined)
                }
                rows={2}
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
              <FieldLabel htmlFor="notes">{t("form.notesLabel")}</FieldLabel>
              <Textarea
                id="notes"
                name={field.name}
                ref={field.ref}
                value={field.value ?? ""}
                onBlur={field.onBlur}
                onChange={(event) =>
                  field.onChange(event.target.value || undefined)
                }
                rows={2}
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() =>
            router.push(
              consumable ? `/consumables/${consumable.id}` : "/consumables",
            )
          }
        >
          {tc("cancel")}
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? t("form.submitSave") : t("form.submitCreate")}
        </Button>
      </div>
    </form>
  );
}
