"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type Consumable,
  CreateConsumableSchema,
  UpdateConsumableSchema,
} from "@lazyit/shared";
import { useRouter } from "next/navigation";
import { Controller, type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useConsumableCategories } from "@/lib/api/hooks/use-consumable-categories";
import {
  useCreateConsumable,
  useUpdateConsumable,
} from "@/lib/api/hooks/use-consumable-mutations";
import { notifyError } from "@/lib/api/notify-error";

const FORM_ID = "consumable-form";
/** Radix Select forbids an empty-string item value; use a sentinel for "no category". */
const NONE = "__none__";

type ConsumableFormValues = {
  name: string;
  sku?: string;
  categoryId?: string;
  description?: string;
  minStock?: number;
  unit: string;
  notes?: string;
};

function toFormValues(consumable?: Consumable): ConsumableFormValues {
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
  return { name: "", unit: "units" };
}

/**
 * Create/edit form for a Consumable. Per-mode validation (CreateConsumableSchema vs the partial
 * UpdateConsumableSchema — ADR-0020). `currentStock` is intentionally absent: it starts at 0 and only
 * changes through stock movements (ADR-0034), never this form.
 */
export function ConsumableForm({ consumable }: { consumable?: Consumable }) {
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
    defaultValues: toFormValues(consumable),
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
            toast.success("Consumable saved");
            router.push(`/consumables/${updated.id}`);
          },
          onError: (error) =>
            notifyError(error, "Couldn't save the consumable"),
        },
      );
    } else {
      createConsumable.mutate(payload, {
        onSuccess: (created) => {
          toast.success("Consumable created");
          router.push(`/consumables/${created.id}`);
        },
        onError: (error) =>
          notifyError(error, "Couldn't create the consumable"),
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
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                {...field}
                id="name"
                value={field.value ?? ""}
                placeholder="USB-C to HDMI adapter"
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
                <FieldLabel htmlFor="sku">SKU</FieldLabel>
                <Input
                  id="sku"
                  name={field.name}
                  ref={field.ref}
                  value={field.value ?? ""}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(event.target.value || undefined)
                  }
                  placeholder="ADP-USBC-HDMI"
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
                <FieldLabel htmlFor="categoryId">Category</FieldLabel>
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
                  <Select
                    value={field.value ?? NONE}
                    onValueChange={(value) =>
                      field.onChange(value === NONE ? undefined : value)
                    }
                  >
                    <SelectTrigger id="categoryId" className="w-full">
                      <SelectValue placeholder="Select a category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— None —</SelectItem>
                      {(categories ?? []).map((category) => (
                        <SelectItem key={category.id} value={category.id}>
                          {category.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CreatableField>
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="minStock"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="minStock">Reorder threshold</FieldLabel>
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
                  placeholder="5"
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldDescription>
                  Low-stock alert when on-hand ≤ this. Optional.
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
                <FieldLabel htmlFor="unit">Unit</FieldLabel>
                <Input
                  {...field}
                  id="unit"
                  value={field.value ?? ""}
                  placeholder="units"
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldDescription>
                  Unit of measure — e.g. units, meters or boxes.
                </FieldDescription>
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
              <FieldLabel htmlFor="description">Description</FieldLabel>
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
              <FieldLabel htmlFor="notes">Notes</FieldLabel>
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
          Cancel
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? "Save changes" : "Create consumable"}
        </Button>
      </div>
    </form>
  );
}
