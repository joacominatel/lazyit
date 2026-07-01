"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  type AssetCategory,
  AssetSpecsDictionarySchema,
  cloneCategoryDefaults,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
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
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateApplicationCategory,
  useUpdateApplicationCategory,
} from "@/lib/api/hooks/use-application-categories";
import {
  useCreateArticleCategory,
  useUpdateArticleCategory,
} from "@/lib/api/hooks/use-article-categories";
import {
  useCreateAssetCategory,
  useUpdateAssetCategory,
} from "@/lib/api/hooks/use-asset-categories";
import {
  useCreateConsumableCategory,
  useUpdateConsumableCategory,
} from "@/lib/api/hooks/use-consumable-categories";
import { notifyError } from "@/lib/api/notify-error";
import {
  dictionaryToRows,
  rowsToDictionary,
  SpecsDictionaryEditor,
  type SpecsDictRow,
} from "./specs-dictionary-editor";
import {
  type AnyCategory,
  type CategoryKind,
  categoryOrder,
  kindHasOrder,
} from "./taxonomy-types";

const FORM_ID = "category-form";

interface FormState {
  name: string;
  description: string;
  icon: string;
  order: string;
}

/**
 * Initial dialog state. Edit → from `category`. Clone → from the shared `cloneCategoryDefaults`
 * sanitizer (name " (copy)"; the non-unique description/icon/order are carried). Otherwise blank.
 */
function toFormState(category?: AnyCategory, cloneSource?: AnyCategory): FormState {
  if (category) {
    return {
      name: category.name,
      description: category.description ?? "",
      icon: category.icon ?? "",
      order:
        categoryOrder(category) !== null
          ? String(categoryOrder(category))
          : "",
    };
  }
  if (cloneSource) {
    const d = cloneCategoryDefaults(cloneSource);
    return {
      name: d.name ?? "",
      description: d.description ?? "",
      icon: d.icon ?? "",
      order: d.order != null ? String(d.order) : "",
    };
  }
  return { name: "", description: "", icon: "", order: "" };
}

type BuildResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

interface CategoryFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: CategoryKind;
  /** Present → edit that category; absent → create a new one. */
  category?: AnyCategory;
  /**
   * Present (and `category` absent) → CREATE pre-filled from this record (issue #125). Distinct from
   * the edit `category` prop: the dialog stays in create mode (CreateXCategorySchema + create
   * mutation) with a " (copy)" name.
   */
  cloneSource?: AnyCategory;
}

/**
 * Create/edit dialog for any of the four category kinds. New component (does NOT touch the existing
 * inline `create-category-dialog`, which the detail chain is converging) — this is the full editor
 * for the Settings → Taxonomies surface: name + optional description/icon, plus an `order` sort key
 * for the kinds that have one (everything but asset categories).
 *
 * The thin wrapper owns the `<Dialog>`; the form body is a separate component keyed by the target
 * record so it remounts (and re-initializes its `useState` from props) whenever the dialog opens for
 * a different category — fresh state without a setState-in-effect.
 */
export function CategoryFormDialog({
  open,
  onOpenChange,
  kind,
  category,
  cloneSource,
}: CategoryFormDialogProps) {
  // Key by mode + target id so reopening for a different record (edit OR clone) remounts with fresh
  // state — no setState-in-effect.
  const recordKey = category
    ? `edit-${category.id}`
    : cloneSource
      ? `clone-${cloneSource.id}`
      : "new";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Asset categories carry the specs-dictionary editor, so they need more room. */}
      <DialogContent
        className={kind === "asset" ? "sm:max-w-2xl" : "sm:max-w-md"}
      >
        {open ? (
          <CategoryForm
            key={`${kind}:${recordKey}`}
            kind={kind}
            category={category}
            cloneSource={cloneSource}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CategoryForm({
  kind,
  category,
  cloneSource,
  onClose,
}: {
  kind: CategoryKind;
  category?: AnyCategory;
  cloneSource?: AnyCategory;
  onClose: () => void;
}) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const isEdit = category != null;

  // All eight mutation hooks are instantiated unconditionally (Rules of Hooks); the active pair is
  // picked by `kind`.
  const createAsset = useCreateAssetCategory();
  const updateAsset = useUpdateAssetCategory();
  const createApplication = useCreateApplicationCategory();
  const updateApplication = useUpdateApplicationCategory();
  const createConsumable = useCreateConsumableCategory();
  const updateConsumable = useUpdateConsumableCategory();
  const createArticle = useCreateArticleCategory();
  const updateArticle = useUpdateArticleCategory();

  const create = {
    asset: createAsset,
    application: createApplication,
    consumable: createConsumable,
    article: createArticle,
  }[kind];
  const update = {
    asset: updateAsset,
    application: updateApplication,
    consumable: updateConsumable,
    article: updateArticle,
  }[kind];

  const isPending = create.isPending || update.isPending;
  const hasOrder = kindHasOrder(kind);
  const label = t(`taxonomies.kindLabel.${kind}`);

  const [values, setValues] = useState<FormState>(() =>
    toFormState(category, cloneSource),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  // Advisory specs dictionary (ADR-0078) — asset kind only. Pre-fill on EDIT; blank on create/clone.
  const [dictRows, setDictRows] = useState<SpecsDictRow[]>(() =>
    kind === "asset" && category
      ? dictionaryToRows((category as AssetCategory).specsSchema)
      : [],
  );
  const [dictError, setDictError] = useState<string | undefined>(undefined);

  function set<K extends keyof FormState>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function buildPayload(): BuildResult {
    const name = values.name.trim();
    if (name.length === 0) {
      return {
        ok: false,
        error: t("taxonomies.categories.form.errors.nameRequired"),
      };
    }

    const description = values.description.trim();
    const icon = values.icon.trim();
    const orderRaw = values.order.trim();

    const payload: Record<string, unknown> = { name };
    if (description.length > 0) payload.description = description;
    if (icon.length > 0) payload.icon = icon;
    if (hasOrder && orderRaw.length > 0) {
      const parsed = Number(orderRaw);
      if (!Number.isInteger(parsed)) {
        return {
          ok: false,
          error: t("taxonomies.categories.form.errors.orderInteger"),
        };
      }
      payload.order = parsed;
    }
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

    // Asset kind: serialize + advisory-validate the specs dictionary (ponytail: reuse the shared zod
    // schema instead of re-implementing the shape checks; the API hard-validates it too).
    if (kind === "asset") {
      const dictionary = rowsToDictionary(dictRows);
      const parsed = AssetSpecsDictionarySchema.safeParse(dictionary);
      if (!parsed.success) {
        setDictError(
          t("taxonomies.categories.form.specsDictionary.errors.invalid"),
        );
        return;
      }
      setDictError(undefined);
      // Omit on CREATE when empty (keeps the payload lean); send [] on EDIT so clearing works.
      if (isEdit || parsed.data.length > 0) {
        built.payload.specsSchema = parsed.data;
      }
    }

    if (category) {
      // PATCH accepts a partial; an unchanged-but-required body still validates (≥1 key present).
      // The per-kind update signatures differ only by their (compatible) body type.
      update.mutate(
        { id: category.id, data: built.payload as never },
        {
          onSuccess: () => {
            toast.success(t("taxonomies.categories.toast.updated", { label }));
            onClose();
          },
          onError: (err) =>
            notifyError(
              err,
              t("taxonomies.categories.toast.updateError", { label }),
            ),
        },
      );
    } else {
      create.mutate(built.payload as never, {
        onSuccess: () => {
          toast.success(t("taxonomies.categories.toast.created", { label }));
          onClose();
        },
        onError: (err) =>
          notifyError(
            err,
            t("taxonomies.categories.toast.createError", { label }),
          ),
      });
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEdit
            ? t("taxonomies.categories.form.editTitle", { label })
            : t("taxonomies.categories.form.newTitle", { label })}
        </DialogTitle>
        <DialogDescription>
          {isEdit
            ? t("taxonomies.categories.form.editDescription")
            : t("taxonomies.categories.form.newDescription")}
        </DialogDescription>
      </DialogHeader>

      <form id={FORM_ID} onSubmit={handleSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="category-name">
              {t("taxonomies.categories.form.nameLabel")}
            </FieldLabel>
            <Input
              id="category-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t("taxonomies.categories.form.namePlaceholder")}
              maxLength={100}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
            {error ? <FieldError errors={[{ message: error }]} /> : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="category-description">
              {t("taxonomies.categories.form.descriptionLabel")}
            </FieldLabel>
            <Textarea
              id="category-description"
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder={t(
                "taxonomies.categories.form.descriptionPlaceholder",
              )}
              rows={2}
              maxLength={1000}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="category-icon">
              {t("taxonomies.categories.form.iconLabel")}
            </FieldLabel>
            <Input
              id="category-icon"
              value={values.icon}
              onChange={(e) => set("icon", e.target.value)}
              placeholder={t("taxonomies.categories.form.iconPlaceholder")}
              maxLength={100}
            />
          </Field>

          {hasOrder ? (
            <Field>
              <FieldLabel htmlFor="category-order">
                {t("taxonomies.categories.form.orderLabel")}
              </FieldLabel>
              <Input
                id="category-order"
                type="number"
                inputMode="numeric"
                value={values.order}
                onChange={(e) => set("order", e.target.value)}
                placeholder={t("taxonomies.categories.form.orderPlaceholder")}
              />
            </Field>
          ) : null}

          {kind === "asset" ? (
            <SpecsDictionaryEditor
              rows={dictRows}
              error={dictError}
              onChange={setDictRows}
            />
          ) : null}
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
            ? t("taxonomies.categories.form.saveChanges")
            : t("taxonomies.categories.form.createButton", { label })}
        </Button>
      </DialogFooter>
    </>
  );
}
