"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateAssetCategorySchema } from "@lazyit/shared";
import { useEffect } from "react";
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CategoryKind, CreatedCategory } from "@/lib/api/endpoints/categories";
import { useCreateCategory } from "@/lib/api/hooks/use-create-category";
import { notifyError } from "@/lib/api/notify-error";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";

const LABEL: Record<CategoryKind, string> = {
  asset: "asset category",
  application: "application category",
  consumable: "consumable category",
  article: "article category",
};

/**
 * Form schema — only a name. The four category create schemas share an identical `name` field, so
 * pick it off one of them (avoids redeclaring the constraint, and keeps web off a direct zod dep).
 */
const FormSchema = CreateAssetCategorySchema.pick({ name: true });
type FormValues = { name: string };

const FORM_ID = "create-category-form";

interface CreateCategoryDialogProps {
  kind: CategoryKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created category so the caller can select it. */
  onCreated?: (category: CreatedCategory) => void;
}

/**
 * Quick-create for a category (any of the four kinds), used by the inline "+ New" on category
 * selects. Collects only a name — the shared field across all category schemas; richer attributes
 * stay editable via the API/seed. Issue #25. Converged onto the react-hook-form + zod +
 * `Field`/`FieldError`/`aria-invalid` contract (validation onTouched; scroll-to-first-error on
 * submit) — public props unchanged.
 */
export function CreateCategoryDialog({
  kind,
  open,
  onOpenChange,
  onCreated,
}: CreateCategoryDialogProps) {
  const create = useCreateCategory(kind);

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: "onTouched",
    defaultValues: { name: "" },
  });

  // Reset whenever it reopens, so a reused dialog never shows a stale name/error.
  useEffect(() => {
    if (open) form.reset({ name: "" });
  }, [open, form]);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  const onSubmit = form.handleSubmit(
    (values) => {
      create.mutate(values.name, {
        onSuccess: (category) => {
          toast.success("Category created");
          onCreated?.(category);
          handleOpenChange(false);
        },
        onError: (error) => notifyError(error, "Couldn't create the category"),
      });
    },
    (_errors, event) => scrollToFirstError(event?.target ?? null),
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New {LABEL[kind]}</DialogTitle>
          <DialogDescription>
            Create a category to use it right away. You can refine it later.
          </DialogDescription>
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
          <Controller
            control={form.control}
            name="name"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="new-category-name" required>
                  Name
                </FieldLabel>
                <Input
                  {...field}
                  id="new-category-name"
                  value={field.value ?? ""}
                  placeholder="e.g. Laptops"
                  aria-invalid={fieldState.invalid || undefined}
                  autoFocus
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} disabled={create.isPending}>
            {create.isPending && <ArrowPathIcon className="animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
