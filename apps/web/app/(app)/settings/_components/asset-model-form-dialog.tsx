"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { type AssetModel, cloneAssetModelDefaults } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
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

const FORM_ID = "asset-model-form";

interface FormState {
  name: string;
  manufacturer: string;
  sku: string;
  description: string;
  categoryId: string;
}

/**
 * Initial dialog state. Edit → from `model`. Clone → from the shared `cloneAssetModelDefaults`
 * sanitizer (name " (copy)", `sku` cleared). Otherwise blank. `specs` has no UI field here; on a
 * clone it's threaded straight into the create payload (see {@link AssetModelForm}).
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
 * Create/edit/clone dialog for an Asset model in the Settings → Taxonomies area. New component (does
 * NOT touch the existing inline `create-asset-model-dialog`). The thin wrapper owns the `<Dialog>`;
 * the body is a keyed inner component so it remounts with fresh state per target (`edit-`/`clone-`/
 * `new` key) — no setState-in-effect. Name + manufacturer are required; SKU, description and the
 * owning asset category are optional. Specs have no UI field (edited via the API/seed), but a clone
 * carries the source's deep-copied specs straight into the create body.
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
      <DialogContent className="sm:max-w-md">
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
  // `specs` has no UI field; on a clone, carry the deep-copied blob into the create body (computed
  // once at mount, stable because the dialog remounts per source via its key).
  const [clonedSpecs] = useState(() =>
    cloneSource && !model ? cloneAssetModelDefaults(cloneSource).specs : undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);

  function set<K extends keyof FormState>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function buildPayload(): BuildResult {
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
    // On a clone, carry the source's deep-copied specs (no UI field) into the create body.
    if (clonedSpecs) payload.specs = clonedSpecs;
    return { ok: true, payload };
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const built = buildPayload();
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
