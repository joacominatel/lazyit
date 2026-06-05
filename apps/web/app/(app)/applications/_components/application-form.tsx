"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type Application,
  cloneApplicationDefaults,
  CreateApplicationSchema,
  UpdateApplicationSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
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

/**
 * Initial form values. Edit → from the persisted `application`. Clone → from the shared
 * `cloneApplicationDefaults` sanitizer (CREATE mode, " (copy)" name; the safe `url` is carried and
 * re-validated by the resolver — SEC-008). Otherwise the blank create defaults.
 */
function toFormValues(
  application?: Application,
  cloneSource?: Application,
): ApplicationFormValues {
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
  if (cloneSource) {
    const d = cloneApplicationDefaults(cloneSource);
    return {
      name: d.name ?? "",
      description: d.description,
      url: d.url,
      vendor: d.vendor,
      categoryId: d.categoryId,
      isCritical: d.isCritical ?? false,
      notes: d.notes,
    };
  }
  return { name: "", isCritical: false };
}

/**
 * Create/edit/clone form for an Application. Per-mode validation (CreateApplicationSchema vs the
 * partial UpdateApplicationSchema — ADR-0020). Clone (`cloneSource`, no `application`) stays in CREATE
 * mode but pre-fills from the shared `cloneApplicationDefaults` sanitizer (issue #125): name
 * " (copy)" and the carried `url`. `url` is a lenient free string but the shared schema rejects
 * dangerous schemes (javascript:/data:/… — SEC-008), surfaced here as a field error — a cloned url is
 * re-validated by the create resolver. `metadata` (jsonb) is not edited here (same deferred debt as
 * Asset.specs — ADR-0007/0023) but, on a clone, the sanitizer's deep-copied `metadata` is carried
 * through to the create payload so the duplicate keeps it.
 */
export function ApplicationForm({
  application,
  cloneSource,
}: {
  application?: Application;
  /** When set (and `application` is not), pre-fill a CREATE form from this record — see issue #125. */
  cloneSource?: Application;
}) {
  const t = useTranslations("applications");
  const tc = useTranslations("common");
  const isEdit = application != null;
  const router = useRouter();
  const { data: categories } = useApplicationCategories();
  const createApplication = useCreateApplication();
  const updateApplication = useUpdateApplication();
  const isPending = createApplication.isPending || updateApplication.isPending;

  // `metadata` has no UI field; on a clone, carry the sanitizer's deep-copied blob into the create
  // payload (computed once) so the duplicate keeps it. Undefined for plain create / edit.
  const clonedMetadata =
    cloneSource && !application
      ? cloneApplicationDefaults(cloneSource).metadata
      : undefined;

  const form = useForm<ApplicationFormValues>({
    resolver: zodResolver(
      isEdit ? UpdateApplicationSchema : CreateApplicationSchema,
    ) as Resolver<ApplicationFormValues>,
    defaultValues: toFormValues(application, cloneSource),
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
            toast.success(t("form.savedToast"));
            router.push(`/applications/${updated.id}`);
          },
          onError: (error) =>
            notifyError(error, t("form.saveError")),
        },
      );
    } else {
      // On a clone, carry the deep-copied metadata (no UI field) into the create body.
      const createPayload = clonedMetadata
        ? { ...payload, metadata: clonedMetadata }
        : payload;
      createApplication.mutate(createPayload, {
        onSuccess: (created) => {
          toast.success(t("form.createdToast"));
          router.push(`/applications/${created.id}`);
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
            name="vendor"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="vendor">{t("form.vendorLabel")}</FieldLabel>
                <Input
                  id="vendor"
                  name={field.name}
                  ref={field.ref}
                  value={field.value ?? ""}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(event.target.value || undefined)
                  }
                  placeholder={t("form.vendorPlaceholder")}
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
                  entityKey="category"
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
                      <SelectValue placeholder={t("form.categoryPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t("form.categoryNone")}</SelectItem>
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
              <FieldLabel htmlFor="url">{t("form.urlLabel")}</FieldLabel>
              <Input
                id="url"
                name={field.name}
                ref={field.ref}
                value={field.value ?? ""}
                onBlur={field.onBlur}
                onChange={(event) =>
                  field.onChange(event.target.value || undefined)
                }
                placeholder={t("form.urlPlaceholder")}
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldDescription>{t("form.urlDescription")}</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />

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
          name="isCritical"
          render={({ field }) => (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="isCritical">
                  {t("form.criticalLabel")}
                </FieldLabel>
                <FieldDescription>
                  {t("form.criticalDescription")}
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
              application ? `/applications/${application.id}` : "/applications",
            )
          }
        >
          {tc("cancel")}
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? t("form.saveSubmit") : t("form.createSubmit")}
        </Button>
      </div>
    </form>
  );
}
