"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import { type AssetModel, CreateAssetModelSchema } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { CategoryCombobox } from "@/components/category-combobox";
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
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useAssetCategories } from "@/lib/api/hooks/use-asset-categories";
import { useCreateAssetModel } from "@/lib/api/hooks/use-asset-models";
import { notifyError } from "@/lib/api/notify-error";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";

const FORM_ID = "create-asset-model-form";

type FormValues = {
  name: string;
  manufacturer: string;
  categoryId?: string;
};

interface CreateAssetModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created model so the caller can select it. */
  onCreated?: (model: AssetModel) => void;
}

/**
 * Quick-create for an AssetModel, used by the inline "+ New" on the asset form's model select.
 * Collects name + manufacturer (both required) and an optional category. The asset category is a
 * plain select here — making it creatable too would nest a dialog inside this one (deferred). Issue
 * #25. Converged onto react-hook-form + zod (`CreateAssetModelSchema`) + the
 * `Field`/`FieldError`/`aria-invalid` contract (validation onTouched; scroll-to-first-error on
 * submit) — public props unchanged.
 */
export function CreateAssetModelDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateAssetModelDialogProps) {
  const t = useTranslations("settings.taxonomies.quickCreate.model");
  const tc = useTranslations("common");
  const { data: categories } = useAssetCategories();
  const create = useCreateAssetModel();

  const form = useForm<FormValues>({
    resolver: zodResolver(CreateAssetModelSchema),
    mode: "onTouched",
    defaultValues: { name: "", manufacturer: "" },
  });

  // Reset whenever it reopens, so a reused dialog never shows stale values/errors.
  useEffect(() => {
    if (open) form.reset({ name: "", manufacturer: "" });
  }, [open, form]);

  const onSubmit = form.handleSubmit(
    (values) => {
      create.mutate(
        {
          name: values.name,
          manufacturer: values.manufacturer,
          ...(values.categoryId ? { categoryId: values.categoryId } : {}),
        },
        {
          onSuccess: (model) => {
            toast.success(t("created"));
            onCreated?.(model);
            onOpenChange(false);
          },
          onError: (error) => notifyError(error, t("createError")),
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
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {/* stopPropagation: this dialog renders in a Radix Portal, but React events bubble through
            the React tree (not the DOM), so without this the inner submit reaches the parent form's
            onSubmit and submits it too (issue #164). */}
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
              name="name"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="new-model-name" required>
                    {t("nameLabel")}
                  </FieldLabel>
                  <Input
                    {...field}
                    id="new-model-name"
                    value={field.value ?? ""}
                    placeholder={t("namePlaceholder")}
                    aria-invalid={fieldState.invalid || undefined}
                    autoFocus
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="manufacturer"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="new-model-manufacturer" required>
                    {t("manufacturerLabel")}
                  </FieldLabel>
                  <Input
                    {...field}
                    id="new-model-manufacturer"
                    value={field.value ?? ""}
                    placeholder={t("manufacturerPlaceholder")}
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
                  <FieldLabel htmlFor="new-model-category">
                    {t("categoryLabel")}
                  </FieldLabel>
                  <CategoryCombobox
                    id="new-model-category"
                    value={field.value ?? ""}
                    onValueChange={(value) =>
                      field.onChange(value === "" ? undefined : value)
                    }
                    categories={categories ?? []}
                    placeholder={t("categoryPlaceholder")}
                    searchPlaceholder={t("searchCategory")}
                    emptyText={t("noCategories")}
                  />
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
            disabled={create.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={create.isPending}>
            {create.isPending && <ArrowPathIcon className="animate-spin" />}
            {tc("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
