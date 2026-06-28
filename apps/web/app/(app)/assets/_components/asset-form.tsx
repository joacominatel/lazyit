"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  applyAssetModelSpecsDefaults,
  type Asset,
  type AssetModel,
  type AssetStatus,
  AssetStatusSchema,
  cloneAssetDefaults,
  CreateAssetSchema,
  renderAssetTag,
  UpdateAssetSchema,
} from "@lazyit/shared";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useReducer } from "react";
import { Controller, type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
import { LocationFormDialog } from "@/app/(app)/locations/_components/location-form-dialog";
import { AssetModelCombobox } from "@/components/asset-model-combobox";
import { CreatableField } from "@/components/creatable-field";
import { CreateAssetModelDialog } from "@/components/create-asset-model-dialog";
import { LocationCombobox } from "@/components/location-combobox";
import { Button } from "@/components/ui/button";
import {
  Field,
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
import { useAssetTagScheme } from "@/lib/api/hooks/use-asset-tag-scheme";
import { useAssetCompanies } from "@/lib/api/hooks/use-assets";
import { useCreateAsset, useUpdateAsset } from "@/lib/api/hooks/use-asset-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";
import { useAssetStatusLabel } from "./asset-status-badge";
import {
  type CustomFieldError,
  type CustomFieldRow,
  CustomFieldsEditor,
  rowsToSpecs,
  specsToRows,
  validateRows,
} from "./custom-fields-editor";

const FORM_ID = "asset-form";

type AssetFormValues = {
  name: string;
  status: AssetStatus;
  modelId?: string;
  locationId?: string;
  serial?: string;
  assetTag?: string;
  company?: string;
  purchaseDate?: string; // ISO datetime
  warrantyEnd?: string; // ISO datetime
  notes?: string;
};

/** ISO datetime → "YYYY-MM-DD" for a date input (empty when absent). */
function isoToDateInput(iso?: string): string {
  return iso ? iso.slice(0, 10) : "";
}

/** "YYYY-MM-DD" from a date input → ISO datetime (undefined when empty). */
function dateInputToIso(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : undefined;
}

/**
 * Initial form values. Edit → from the persisted `asset`. Clone → from the shared
 * `cloneAssetDefaults` sanitizer (CREATE mode, unique fields cleared, " (copy)" name). Otherwise the
 * blank create defaults.
 */
function toFormValues(asset?: Asset, cloneSource?: Asset): AssetFormValues {
  if (asset) {
    return {
      name: asset.name,
      status: asset.status,
      modelId: asset.modelId ?? undefined,
      locationId: asset.locationId ?? undefined,
      serial: asset.serial ?? undefined,
      assetTag: asset.assetTag ?? undefined,
      company: asset.company ?? undefined,
      purchaseDate: asset.purchaseDate ?? undefined,
      warrantyEnd: asset.warrantyEnd ?? undefined,
      notes: asset.notes ?? undefined,
    };
  }
  if (cloneSource) {
    const d = cloneAssetDefaults(cloneSource);
    return {
      name: d.name ?? "",
      status: d.status ?? "OPERATIONAL",
      modelId: d.modelId,
      locationId: d.locationId,
      // serial/assetTag are cleared by the sanitizer → render empty.
      serial: d.serial,
      assetTag: d.assetTag,
      company: d.company,
      purchaseDate: d.purchaseDate,
      warrantyEnd: d.warrantyEnd,
      notes: d.notes,
    };
  }
  return { name: "", status: "OPERATIONAL" };
}

/** The specs editor's grouped state — see {@link AssetForm}. */
type SpecsState = {
  rows: CustomFieldRow[];
  preserved: Record<string, unknown>;
  errors: Record<string, CustomFieldError>;
  /** "Manufacturer Model" when the rows were seeded from a model's default specs, else undefined. */
  modelSource: string | undefined;
};

type SpecsAction =
  | { type: "rowsChanged"; rows: CustomFieldRow[] }
  | { type: "errorsSet"; errors: Record<string, CustomFieldError> }
  | { type: "modelApplied"; model: AssetModel }
  | { type: "modelCleared" };

function specsReducer(state: SpecsState, action: SpecsAction): SpecsState {
  switch (action.type) {
    case "rowsChanged":
      // Editing rows clears any pending errors — only when there were some, to keep the reference.
      return {
        ...state,
        rows: action.rows,
        errors: Object.keys(state.errors).length > 0 ? {} : state.errors,
      };
    case "errorsSet":
      return { ...state, errors: action.errors };
    case "modelApplied": {
      // Merge the model's default specs into the current rows, then re-split into rows + preserved.
      const currentSpecs = rowsToSpecs(state.rows, state.preserved);
      const merged = applyAssetModelSpecsDefaults(
        action.model.specs,
        currentSpecs,
      );
      const { rows, preserved } = specsToRows(merged);
      return {
        rows,
        preserved,
        errors: {},
        modelSource:
          action.model.specs && Object.keys(action.model.specs).length > 0
            ? `${action.model.manufacturer} ${action.model.name}`
            : undefined,
      };
    }
    case "modelCleared":
      return { ...state, modelSource: undefined };
  }
}

/**
 * Create/edit/clone form for an Asset. Per-mode validation (CreateAssetSchema vs the
 * partial UpdateAssetSchema — ADR-0020). Clone (`cloneSource`, no `asset`) stays in CREATE mode but
 * pre-fills from the shared `cloneAssetDefaults` sanitizer (issue #125): name " (copy)", deep-copied
 * specs, and the unique `serial`/`assetTag` cleared so they render empty for the operator. `specs` is
 * free-form jsonb edited through the {@link CustomFieldsEditor}: a dynamic list of `{ name, value }`
 * rows that serialize into the `specs` object on submit (per-category schemas are deferred —
 * ADR-0007). Non-scalar legacy entries (arrays/objects) are preserved untouched. Dates are edited as
 * date inputs and stored as ISO datetimes (the wire shape).
 */
export function AssetForm({
  asset,
  cloneSource,
}: {
  asset?: Asset;
  /** When set (and `asset` is not), pre-fill a CREATE form from this record — see issue #125. */
  cloneSource?: Asset;
}) {
  const isEdit = asset != null;
  const router = useRouter();
  const t = useTranslations("assets.form");
  const tc = useTranslations("common");
  const statusLabel = useAssetStatusLabel();
  const createAsset = useCreateAsset();
  const updateAsset = useUpdateAsset();
  const isPending = createAsset.isPending || updateAsset.isPending;

  // Asset-tag scheme hint (ADR-0063, #363): on CREATE, when the org enabled an auto-tag scheme, hint the
  // next auto-generated tag as the `assetTag` placeholder so the operator knows leaving it blank
  // auto-assigns. The field stays optional and an explicit value still wins (the scheme only fills the
  // gap server-side). Never shown on edit, and a no-op when the scheme is OFF/absent (today's behaviour).
  const { data: tagScheme } = useAssetTagScheme();
  // Distinct existing company values for the free-text autocomplete datalist (ADR-0076). A plain
  // suggestion list — the operator can still type a brand-new value.
  const { data: companies } = useAssetCompanies();
  const autoTagHint =
    !isEdit && tagScheme?.enabled
      ? renderAssetTag(tagScheme, tagScheme.nextNumber)
      : undefined;

  // Specs source: the edited asset's specs, or the clone source's (deep-copied by the sanitizer).
  const specsSource = asset?.specs ?? cloneSource?.specs;
  // The specs editor is one machine (rows + preserved non-scalar entries + per-row errors + the
  // model the defaults were copied from) — see `specsReducer`. Lazily split the source specs once.
  const [specState, dispatchSpec] = useReducer(
    specsReducer,
    specsSource,
    (src) => {
      const { rows, preserved } = specsToRows(src);
      return { rows, preserved, errors: {}, modelSource: undefined };
    },
  );
  // Did the asset arrive with any specs? Used to clear them on edit (see onSubmit).
  const hadSpecs = asset?.specs != null && Object.keys(asset.specs).length > 0;

  const form = useForm<AssetFormValues>({
    resolver: zodResolver(
      isEdit ? UpdateAssetSchema : CreateAssetSchema,
    ) as Resolver<AssetFormValues>,
    defaultValues: toFormValues(asset, cloneSource),
  });

  function applyModelSpecs(model: AssetModel) {
    if (isEdit) return;
    dispatchSpec({ type: "modelApplied", model });
  }

  const specLabels = {
    label: t("customFields.label"),
    description: t("customFields.description"),
    empty: t("customFields.empty"),
    namePlaceholder: t("customFields.namePlaceholder"),
    valuePlaceholder: t("customFields.valuePlaceholder"),
    removeFieldTitle: t("customFields.removeFieldTitle"),
    addField: t("customFields.addField"),
    nameRequired: t("customFields.nameRequired"),
    duplicateName: t("customFields.duplicateName"),
    fieldNameLabel: (index: number) =>
      t("customFields.fieldNameLabel", { index }),
    fieldValueLabel: (index: number) =>
      t("customFields.fieldValueLabel", { index }),
    removeFieldLabel: (index: number) =>
      t("customFields.removeFieldLabel", { index }),
  };

  const onSubmit = form.handleSubmit(
    (values) => {
      // Validate the custom-field rows (non-empty + unique names); abort on any error.
      const { errors, ok } = validateRows(specState.rows);
      dispatchSpec({ type: "errorsSet", errors });
      if (!ok) {
        // The custom-field rows live outside RHF, so a row error never reaches RHF's `onInvalid`.
        // The spec rows set `aria-invalid` too, so the shared helper (which defers a frame for the
        // just-set errors to paint) finds the first one in DOM order and scrolls/focuses it.
        scrollToFirstError(document.getElementById(FORM_ID));
        return;
      }

      // Serialize rows into the specs object, merging preserved non-scalar entries.
      let specs = rowsToSpecs(specState.rows, specState.preserved);
      // On edit, if the user cleared every field but the asset previously had specs,
      // send `{}` to actually clear them (an omitted key is a no-op in a PATCH).
      if (isEdit && specs === undefined && hadSpecs) specs = {};

      const payload = {
        name: values.name,
        status: values.status,
        serial: values.serial,
        assetTag: values.assetTag,
        modelId: values.modelId,
        locationId: values.locationId,
        company: values.company,
        purchaseDate: values.purchaseDate,
        warrantyEnd: values.warrantyEnd,
        notes: values.notes,
        specs,
      };

      if (asset) {
        updateAsset.mutate(
          { id: asset.id, data: payload },
          {
            onSuccess: (updated) => {
              toast.success(t("savedToast"));
              router.push(`/assets/${updated.id}`);
            },
            onError: (error) => notifyError(error, t("saveError")),
          },
        );
      } else {
        createAsset.mutate(payload, {
          onSuccess: (created) => {
            toast.success(t("createdToast"));
            router.push(`/assets/${created.id}`);
          },
          onError: (error) => notifyError(error, t("createError")),
        });
      }
    },
    (_errors, event) => scrollToFirstError(event?.target ?? null),
  );

  return (
    <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-6">
      <FieldGroup>
        <Controller
          control={form.control}
          name="name"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="name">{t("name")}</FieldLabel>
              <Input
                {...field}
                id="name"
                value={field.value ?? ""}
                placeholder={t("namePlaceholder")}
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
            name="status"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="status">{t("status")}</FieldLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AssetStatusSchema.options.map((status) => (
                      <SelectItem key={status} value={status}>
                        {statusLabel(status)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="modelId"
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="modelId">{t("model")}</FieldLabel>
                <CreatableField
                  entityKey="model"
                  renderDialog={(dialog) => (
                    <CreateAssetModelDialog
                      open={dialog.open}
                      onOpenChange={dialog.onOpenChange}
                      onCreated={(model) => {
                        field.onChange(model.id);
                        applyModelSpecs(model);
                      }}
                    />
                  )}
                >
                  <AssetModelCombobox
                    id="modelId"
                    value={field.value ?? ""}
                    onValueChange={(value) => {
                      const next = value === "" ? undefined : value;
                      field.onChange(next);
                      dispatchSpec({ type: "modelCleared" });
                    }}
                    onModelSelect={applyModelSpecs}
                    placeholder={t("modelPlaceholder")}
                    searchPlaceholder={t("searchModel")}
                    emptyText={t("noModels")}
                  />
                </CreatableField>
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="locationId"
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="locationId">{t("location")}</FieldLabel>
                <CreatableField
                  entityKey="location"
                  renderDialog={(dialog) => (
                    <LocationFormDialog
                      open={dialog.open}
                      onOpenChange={dialog.onOpenChange}
                      onCreated={(location) => field.onChange(location.id)}
                    />
                  )}
                >
                  <LocationCombobox
                    id="locationId"
                    value={field.value ?? ""}
                    onValueChange={(value) =>
                      field.onChange(value === "" ? undefined : value)
                    }
                    placeholder={t("locationPlaceholder")}
                    searchPlaceholder={t("searchLocation")}
                    emptyText={t("noLocations")}
                  />
                </CreatableField>
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="company"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="company">{t("company")}</FieldLabel>
                <Input
                  id="company"
                  name={field.name}
                  ref={field.ref}
                  value={field.value ?? ""}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(event.target.value || undefined)
                  }
                  // Free-text + autocomplete over existing values (ADR-0076): a native datalist so the
                  // operator reuses a value or types a new one — no Company entity/picker.
                  list="asset-company-options"
                  placeholder={t("companyPlaceholder")}
                  aria-invalid={fieldState.invalid || undefined}
                />
                <datalist id="asset-company-options">
                  {(companies ?? []).map((company) => (
                    <option key={company} value={company} />
                  ))}
                </datalist>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="serial"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="serial">{t("serial")}</FieldLabel>
                <Input
                  id="serial"
                  name={field.name}
                  ref={field.ref}
                  value={field.value ?? ""}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(event.target.value || undefined)
                  }
                  placeholder={t("serialPlaceholder")}
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="assetTag"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="assetTag">{t("assetTag")}</FieldLabel>
                <Input
                  id="assetTag"
                  name={field.name}
                  ref={field.ref}
                  value={field.value ?? ""}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(event.target.value || undefined)
                  }
                  placeholder={
                    autoTagHint
                      ? t("assetTagAutoHint", { tag: autoTagHint })
                      : t("assetTagPlaceholder")
                  }
                  className="font-mono"
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="purchaseDate"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="purchaseDate">{t("purchaseDate")}</FieldLabel>
                <Input
                  id="purchaseDate"
                  type="date"
                  name={field.name}
                  ref={field.ref}
                  value={isoToDateInput(field.value)}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(dateInputToIso(event.target.value))
                  }
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="warrantyEnd"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="warrantyEnd">{t("warrantyEnd")}</FieldLabel>
                <Input
                  id="warrantyEnd"
                  type="date"
                  name={field.name}
                  ref={field.ref}
                  value={isoToDateInput(field.value)}
                  onBlur={field.onBlur}
                  onChange={(event) =>
                    field.onChange(dateInputToIso(event.target.value))
                  }
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </div>

        <Controller
          control={form.control}
          name="notes"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="notes">{t("notes")}</FieldLabel>
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

        <CustomFieldsEditor
          rows={specState.rows}
          errors={specState.errors}
          labels={specLabels}
          note={
            specState.modelSource
              ? t("customFields.copiedFromModel", {
                  model: specState.modelSource,
                })
              : undefined
          }
          onChange={(rows) => dispatchSpec({ type: "rowsChanged", rows })}
        />
      </FieldGroup>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() => router.push(asset ? `/assets/${asset.id}` : "/assets")}
        >
          {tc("cancel")}
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? t("saveChanges") : t("createAsset")}
        </Button>
      </div>
    </form>
  );
}
