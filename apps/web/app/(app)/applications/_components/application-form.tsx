"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type Application,
  CreateApplicationSchema,
  UpdateApplicationSchema,
} from "@lazyit/shared";
import { useRouter } from "next/navigation";
import { Controller, type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
import { CreatableField } from "@/components/creatable-field";
import { CreateCategoryDialog } from "@/components/create-category-dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useApplicationCategories } from "@/lib/api/hooks/use-application-categories";
import {
  useCreateApplication,
  useUpdateApplication,
} from "@/lib/api/hooks/use-application-mutations";
import { notifyError } from "@/lib/api/notify-error";

const FORM_ID = "application-form";
/** Radix Select forbids an empty-string item value; use a sentinel for "no category". */
const NONE = "__none__";

type ApplicationFormValues = {
  name: string;
  description?: string;
  url?: string;
  vendor?: string;
  categoryId?: string;
  isCritical: boolean;
  notes?: string;
};

function toFormValues(application?: Application): ApplicationFormValues {
  if (application) {
    return {
      name: application.name,
      description: application.description ?? undefined,
      url: application.url ?? undefined,
      vendor: application.vendor ?? undefined,
      categoryId: application.categoryId ?? undefined,
      isCritical: application.isCritical,
      notes: application.notes ?? undefined,
    };
  }
  return { name: "", isCritical: false };
}

/**
 * Create/edit form for an Application. Per-mode validation (CreateApplicationSchema vs the partial
 * UpdateApplicationSchema — ADR-0020). `url` is a lenient free string but the shared schema rejects
 * dangerous schemes (javascript:/data:/… — SEC-008), surfaced here as a field error. `metadata`
 * (jsonb) is not edited here — same deferred debt as Asset.specs (ADR-0007/0023).
 */
export function ApplicationForm({
  application,
}: {
  application?: Application;
}) {
  const isEdit = application != null;
  const router = useRouter();
  const { data: categories } = useApplicationCategories();
  const createApplication = useCreateApplication();
  const updateApplication = useUpdateApplication();
  const isPending = createApplication.isPending || updateApplication.isPending;

  const form = useForm<ApplicationFormValues>({
    resolver: zodResolver(
      isEdit ? UpdateApplicationSchema : CreateApplicationSchema,
    ) as Resolver<ApplicationFormValues>,
    defaultValues: toFormValues(application),
  });

  const onSubmit = form.handleSubmit((values) => {
    const payload = {
      name: values.name,
      description: values.description,
      url: values.url,
      vendor: values.vendor,
      categoryId: values.categoryId,
      isCritical: values.isCritical,
      notes: values.notes,
    };

    if (application) {
      updateApplication.mutate(
        { id: application.id, data: payload },
        {
          onSuccess: (updated) => {
            toast.success("Application saved");
            router.push(`/applications/${updated.id}`);
          },
          onError: (error) =>
            notifyError(error, "Couldn't save the application"),
        },
      );
    } else {
      createApplication.mutate(payload, {
        onSuccess: (created) => {
          toast.success("Application created");
          router.push(`/applications/${created.id}`);
        },
        onError: (error) =>
          notifyError(error, "Couldn't create the application"),
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
                placeholder="GitHub"
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
            name="vendor"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="vendor">Vendor</FieldLabel>
                <Input
                  id="vendor"
                  name={field.name}
                  ref={field.ref}
                  value={field.value ?? ""}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(event.target.value || undefined)
                  }
                  placeholder="Atlassian, Microsoft, AWS…"
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
                      kind="application"
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
        </div>

        <Controller
          control={form.control}
          name="url"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="url">URL</FieldLabel>
              <Input
                id="url"
                name={field.name}
                ref={field.ref}
                value={field.value ?? ""}
                onBlur={field.onBlur}
                onChange={(event) =>
                  field.onChange(event.target.value || undefined)
                }
                placeholder="https://github.com or vpn.corp.local"
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldDescription>
                Scheme-less hosts and http(s) only; other schemes are rejected.
              </FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />

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
          name="isCritical"
          render={({ field }) => (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="isCritical">Critical</FieldLabel>
                <FieldDescription>
                  Access here is especially sensitive (production infra,
                  finance) and is highlighted in listings.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="isCritical"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
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
              application ? `/applications/${application.id}` : "/applications",
            )
          }
        >
          Cancel
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? "Save changes" : "Create application"}
        </Button>
      </div>
    </form>
  );
}
