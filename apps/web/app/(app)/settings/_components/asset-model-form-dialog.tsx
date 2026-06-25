"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { type AssetModel, cloneAssetModelDefaults } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useReducer, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { useAssetCategories } from "@/lib/api/hooks/use-asset-categories";
import {
  useCreateAssetModel,
  useUpdateAssetModel,
} from "@/lib/api/hooks/use-asset-models";
import { notifyError } from "@/lib/api/notify-error";
import {
  type SpecsFieldError,
  type SpecsFieldRow,
  rowsToSpecs,
  SpecsFieldsEditor,
  specsToRows,
  validateRows,
} from "@/components/specs-fields-editor";

const FORM_ID = "asset-model-form";

interface FormState {
  name: string;
  manufacturer: string;
  sku: string;
  description: string;
  categoryId: string;
}

/**
 * initial dialog state. edit → from `model`. clone → from the shared `cloneAssetModelDefaults`
 * sanitizer (name " (copy)", `sku` cleared). otherwise blank
 */
function toFormState(model?: AssetModel, cloneSource?: AssetModel): FormState {
  if (model) {
    return {
      name: model.name,
      manufacturer: model.manufacturer,
      sku: model.sku ?? "",
      description: model.description ?? "",
      categoryId: model.categoryId ?? "",
    };
  }
  if (cloneSource) {
    const d = cloneAssetModelDefaults(cloneSource);
    return {
      name: d.name ?? "",
      manufacturer: d.manufacturer ?? "",
      // sku is cleared by the sanitizer → render empty.
      sku: d.sku ?? "",
      description: d.description ?? "",
      categoryId: d.categoryId ?? "",
    };
  }
  return { name: "", manufacturer: "", sku: "", description: "", categoryId: "" };
}

type BuildResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

/** The default-specs editor's grouped state — see {@link AssetModelForm}. */
type SpecsState = {
  rows: SpecsFieldRow[];
  preserved: Record<string, unknown>;
  errors: Record<string, SpecsFieldError>;
};

type SpecsAction =
  | { type: "rowsChanged"; rows: SpecsFieldRow[] }
  | { type: "errorsSet"; errors: Record<string, SpecsFieldError> };

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
  }
}

interface AssetModelFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit that model; absent → create a new one. */
  model?: AssetModel;
  /**
   * Present (and `model` absent) → CREATE pre-filled from this record (issue #125). Distinct from the
   * edit `model` prop: the dialog stays in create mode (CreateAssetModelSchema + create mutation).
   */
  cloneSource?: AssetModel;
}

/**
 * create/edit/clone dialog for an asset model in settings → taxonomies. the thin wrapper owns the
 * `<Dialog>`; the body remounts per target so stale state never leaks between edit/clone/new
 */
export function AssetModelFormDialog({
  open,
  onOpenChange,
  model,
  cloneSource,
}: AssetModelFormDialogProps) {
  // A clone keys off the source id so reopening for a different source remounts with fresh state.
  const key = model
    ? `edit-${model.id}`
    : cloneSource
      ? `clone-${cloneSource.id}`
      : "new";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open ? (
          <AssetModelForm
            key={key}
            model={model}
            cloneSource={cloneSource}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AssetModelForm({
  model,
  cloneSource,
  onClose,
}: {
  model?: AssetModel;
  cloneSource?: AssetModel;
  onClose: () => void;
}) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const isEdit = model != null;
  const create = useCreateAssetModel();
  const update = useUpdateAssetModel();
  const { data: categories } = useAssetCategories();
  const isPending = create.isPending || update.isPending;

  const [values, setValues] = useState<FormState>(() =>
    toFormState(model, cloneSource),
  );
  const specsSource =
    model?.specs ??
    (cloneSource && !model ? cloneAssetModelDefaults(cloneSource).specs : undefined);
  // The specs editor (rows + preserved non-scalar entries + per-row errors) is one machine — see
  // `specsReducer`. Lazily split the source specs once.
  const [specState, dispatchSpec] = useReducer(
    specsReducer,
    specsSource,
    (src) => {
      const { rows, preserved } = specsToRows(src);
      return { rows, preserved, errors: {} };
    },
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const hadSpecs = model?.specs != null && Object.keys(model.specs).length > 0;
  const specLabels = {
    label: t("taxonomies.models.form.defaultSpecs.label"),
    description: t("taxonomies.models.form.defaultSpecs.description"),
    empty: t("taxonomies.models.form.defaultSpecs.empty"),
    namePlaceholder: t("taxonomies.models.form.defaultSpecs.namePlaceholder"),
    valuePlaceholder: t("taxonomies.models.form.defaultSpecs.valuePlaceholder"),
    removeFieldTitle: t("taxonomies.models.form.defaultSpecs.removeFieldTitle"),
    addField: t("taxonomies.models.form.defaultSpecs.addField"),
    nameRequired: t("taxonomies.models.form.defaultSpecs.nameRequired"),
    duplicateName: t("taxonomies.models.form.defaultSpecs.duplicateName"),
    fieldNameLabel: (index: number) =>
      t("taxonomies.models.form.defaultSpecs.fieldNameLabel", { index }),
    fieldValueLabel: (index: number) =>
      t("taxonomies.models.form.defaultSpecs.fieldValueLabel", { index }),
    removeFieldLabel: (index: number) =>
      t("taxonomies.models.form.defaultSpecs.removeFieldLabel", { index }),
  };

  function set<K extends keyof FormState>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function buildPayload(
    specs: Record<string, unknown> | undefined,
  ): BuildResult {
    const name = values.name.trim();
    const manufacturer = values.manufacturer.trim();
    if (name.length === 0) {
      return {
        ok: false,
        error: t("taxonomies.models.form.errors.nameRequired"),
      };
    }
    if (manufacturer.length === 0) {
      return {
        ok: false,
        error: t("taxonomies.models.form.errors.manufacturerRequired"),
      };
    }

    const sku = values.sku.trim();
    const description = values.description.trim();

    const payload: Record<string, unknown> = { name, manufacturer };
    if (sku.length > 0) payload.sku = sku;
    if (description.length > 0) payload.description = description;
    if (values.categoryId.length > 0) payload.categoryId = values.categoryId;
    if (specs !== undefined) payload.specs = specs;
    return { ok: true, payload };
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const { errors, ok } = validateRows(specState.rows);
    dispatchSpec({ type: "errorsSet", errors });
    if (!ok) return;

    let specs = rowsToSpecs(specState.rows, specState.preserved);
    if (isEdit && specs === undefined && hadSpecs) specs = {};

    const built = buildPayload(specs);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(undefined);

    if (model) {
      update.mutate(
        { id: model.id, data: built.payload as never },
        {
          onSuccess: () => {
            toast.success(t("taxonomies.models.toast.updated"));
            onClose();
          },
          onError: (err) =>
            notifyError(err, t("taxonomies.models.toast.updateError")),
        },
      );
    } else {
      create.mutate(built.payload as never, {
        onSuccess: () => {
          toast.success(t("taxonomies.models.toast.created"));
          onClose();
        },
        onError: (err) =>
          notifyError(err, t("taxonomies.models.toast.createError")),
      });
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEdit
            ? t("taxonomies.models.form.editTitle")
            : t("taxonomies.models.form.newTitle")}
        </DialogTitle>
        <DialogDescription>
          {isEdit
            ? t("taxonomies.models.form.editDescription")
            : t("taxonomies.models.form.newDescription")}
        </DialogDescription>
      </DialogHeader>

      <form id={FORM_ID} onSubmit={handleSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="model-name">
              {t("taxonomies.models.form.nameLabel")}
            </FieldLabel>
            <Input
              id="model-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t("taxonomies.models.form.namePlaceholder")}
              maxLength={200}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
          </Field>

          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="model-manufacturer">
              {t("taxonomies.models.form.manufacturerLabel")}
            </FieldLabel>
            <Input
              id="model-manufacturer"
              value={values.manufacturer}
              onChange={(e) => set("manufacturer", e.target.value)}
              placeholder={t("taxonomies.models.form.manufacturerPlaceholder")}
              maxLength={200}
              aria-invalid={error ? true : undefined}
            />
            {error ? <FieldError errors={[{ message: error }]} /> : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="model-sku">
              {t("taxonomies.models.form.skuLabel")}
            </FieldLabel>
            <Input
              id="model-sku"
              value={values.sku}
              onChange={(e) => set("sku", e.target.value)}
              placeholder={t("taxonomies.models.form.skuPlaceholder")}
              maxLength={100}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="model-category">
              {t("taxonomies.models.form.categoryLabel")}
            </FieldLabel>
            <CategoryCombobox
              id="model-category"
              value={values.categoryId}
              onValueChange={(value) => set("categoryId", value)}
              categories={categories ?? []}
              placeholder={t("taxonomies.models.form.categoryPlaceholder")}
              searchPlaceholder={t("taxonomies.models.form.searchCategory")}
              emptyText={t("taxonomies.models.form.noCategories")}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="model-description">
              {t("taxonomies.models.form.descriptionLabel")}
            </FieldLabel>
            <Textarea
              id="model-description"
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder={t("taxonomies.models.form.descriptionPlaceholder")}
              rows={2}
              maxLength={2000}
            />
          </Field>

          <SpecsFieldsEditor
            rows={specState.rows}
            errors={specState.errors}
            labels={specLabels}
            onChange={(rows) => dispatchSpec({ type: "rowsChanged", rows })}
          />
        </FieldGroup>
      </form>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={isPending}
        >
          {tc("cancel")}
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit
            ? t("taxonomies.models.form.saveChanges")
            : t("taxonomies.models.form.createButton")}
        </Button>
      </DialogFooter>
    </>
  );
}
