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
import { useState } from "react";
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
  FieldLegend,
  FieldSeparator,
  FieldSet,
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
import { majorToMinor, minorToMajor } from "@/lib/utils/money";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";

const FORM_ID = "application-form";
/** Radix Select forbids an empty-string item value; use a sentinel for "no category". */
const NONE = "__none__";

/** ISO datetime → "YYYY-MM-DD" for a date input (empty when absent). */
function isoToDateInput(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

/** "YYYY-MM-DD" from a date input → ISO datetime; `null` when empty so a PATCH can CLEAR it. */
function dateInputToIso(value: string): string | null {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;
}

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

  // License / seat tracking (#949) lives OUTSIDE react-hook-form — same rationale as the asset money
  // fields (#954): they're edited in MAJOR units / raw text, but the schema validates minor-unit ints,
  // and a `strictObject` resolver would reject a half-typed "12.". Seed from the edited application, or
  // (on a clone) the source's plan config. `renewalDate` is a specific subscription date, so it seeds
  // only on edit — a clone starts with a blank renewal, mirroring how asset clones drop dates.
  const licenseSource = application ?? cloneSource;
  const [seatsPurchased, setSeatsPurchased] = useState(() =>
    licenseSource?.seatsPurchased != null
      ? String(licenseSource.seatsPurchased)
      : "",
  );
  const [costPerSeat, setCostPerSeat] = useState(() =>
    licenseSource?.costPerSeat != null
      ? String(minorToMajor(licenseSource.costPerSeat))
      : "",
  );
  const [renewalDate, setRenewalDate] = useState(() =>
    isoToDateInput(application?.renewalDate),
  );

  const onSubmit = form.handleSubmit((values) => {
    // License fields → wire shape. Blank = null (create: "untracked"; PATCH: clear it). Seats is a
    // plain non-negative int; costPerSeat is major-unit text coerced to minor units (never re-coerced
    // server-side); renewalDate is an ISO datetime (or null). The server re-validates non-negative.
    const seats = seatsPurchased.trim();
    const seatsPurchasedValue =
      seats === "" || !Number.isFinite(Number(seats))
        ? null
        : Math.trunc(Number(seats));
    const payload = {
      name: values.name,
      description: values.description,
      url: values.url,
      vendor: values.vendor,
      categoryId: values.categoryId,
      isCritical: values.isCritical,
      notes: values.notes,
      seatsPurchased: seatsPurchasedValue,
      costPerSeat: majorToMinor(costPerSeat),
      renewalDate: dateInputToIso(renewalDate),
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
  }, (_errors, event) => scrollToFirstError(event?.target ?? null));

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
              {/* `name` is `min(1).max(200)`; only the empty case is common — swap in the localized
                  copy for the required case rather than leak the raw zod message (issue #966, same
                  class as the KB article `title` fix). */}
              <FieldError
                errors={[
                  fieldState.error?.type === "too_small"
                    ? { message: t("form.nameRequired") }
                    : fieldState.error,
                ]}
              />
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

      {/* ── License & seats (#949): optional per-application license tracking. Seats purchased + cost
          per seat (entered in major units, stored in minor units like asset cost) + a renewal date.
          "Seats used" is derived on the detail page from distinct active grants — never entered here.
          All optional: leave blank for apps whose licensing you don't track. ────────────────────── */}
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>{t("form.licenseTitle")}</FieldLegend>
        <FieldDescription>{t("form.licenseDescription")}</FieldDescription>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="seatsPurchased">
                {t("form.seatsPurchasedLabel")}
              </FieldLabel>
              <Input
                id="seatsPurchased"
                type="number"
                inputMode="numeric"
                min="0"
                step="1"
                value={seatsPurchased}
                onChange={(event) => setSeatsPurchased(event.target.value)}
                placeholder={t("form.seatsPurchasedPlaceholder")}
              />
              <FieldDescription>
                {t("form.seatsPurchasedHelp")}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="costPerSeat">
                {t("form.costPerSeatLabel")}
              </FieldLabel>
              <Input
                id="costPerSeat"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={costPerSeat}
                onChange={(event) => setCostPerSeat(event.target.value)}
                placeholder={t("form.costPerSeatPlaceholder")}
              />
              <FieldDescription>{t("form.costPerSeatHelp")}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="renewalDate">
                {t("form.renewalDateLabel")}
              </FieldLabel>
              <Input
                id="renewalDate"
                type="date"
                value={renewalDate}
                onChange={(event) => setRenewalDate(event.target.value)}
              />
              <FieldDescription>{t("form.renewalDateHelp")}</FieldDescription>
            </Field>
          </div>
        </FieldGroup>
      </FieldSet>

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
