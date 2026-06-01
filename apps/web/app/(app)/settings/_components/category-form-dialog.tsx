"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
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
  type AnyCategory,
  CATEGORY_KIND_LABEL,
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

function toFormState(category?: AnyCategory): FormState {
  return {
    name: category?.name ?? "",
    description: category?.description ?? "",
    icon: category?.icon ?? "",
    order:
      category && categoryOrder(category) !== null
        ? String(categoryOrder(category))
        : "",
  };
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
}: CategoryFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <CategoryForm
            key={`${kind}:${category?.id ?? "new"}`}
            kind={kind}
            category={category}
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
  onClose,
}: {
  kind: CategoryKind;
  category?: AnyCategory;
  onClose: () => void;
}) {
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
  const label = CATEGORY_KIND_LABEL[kind];

  const [values, setValues] = useState<FormState>(() => toFormState(category));
  const [error, setError] = useState<string | undefined>(undefined);

  function set<K extends keyof FormState>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function buildPayload(): BuildResult {
    const name = values.name.trim();
    if (name.length === 0) return { ok: false, error: "Name is required." };

    const description = values.description.trim();
    const icon = values.icon.trim();
    const orderRaw = values.order.trim();

    const payload: Record<string, unknown> = { name };
    if (description.length > 0) payload.description = description;
    if (icon.length > 0) payload.icon = icon;
    if (hasOrder && orderRaw.length > 0) {
      const parsed = Number(orderRaw);
      if (!Number.isInteger(parsed)) {
        return { ok: false, error: "Order must be a whole number." };
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

    if (category) {
      // PATCH accepts a partial; an unchanged-but-required body still validates (≥1 key present).
      // The per-kind update signatures differ only by their (compatible) body type.
      update.mutate(
        { id: category.id, data: built.payload as never },
        {
          onSuccess: () => {
            toast.success(`Updated ${label}`);
            onClose();
          },
          onError: (err) => notifyError(err, `Couldn't update ${label}`),
        },
      );
    } else {
      create.mutate(built.payload as never, {
        onSuccess: () => {
          toast.success(`Created ${label}`);
          onClose();
        },
        onError: (err) => notifyError(err, `Couldn't create ${label}`),
      });
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEdit ? `Edit ${label}` : `New ${label}`}</DialogTitle>
        <DialogDescription>
          {isEdit
            ? "Update the details of this category."
            : "Categories classify records across the app. Name is required; the rest are optional."}
        </DialogDescription>
      </DialogHeader>

      <form id={FORM_ID} onSubmit={handleSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="category-name">Name</FieldLabel>
            <Input
              id="category-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Laptops"
              maxLength={100}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
            {error ? <FieldError errors={[{ message: error }]} /> : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="category-description">Description</FieldLabel>
            <Textarea
              id="category-description"
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Optional — what belongs in this category."
              rows={2}
              maxLength={1000}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="category-icon">Icon</FieldLabel>
            <Input
              id="category-icon"
              value={values.icon}
              onChange={(e) => set("icon", e.target.value)}
              placeholder="Optional — a heroicon name, e.g. ServerStackIcon"
              maxLength={100}
            />
          </Field>

          {hasOrder ? (
            <Field>
              <FieldLabel htmlFor="category-order">Order</FieldLabel>
              <Input
                id="category-order"
                type="number"
                inputMode="numeric"
                value={values.order}
                onChange={(e) => set("order", e.target.value)}
                placeholder="Optional — lower sorts first"
              />
            </Field>
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
          Cancel
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? "Save changes" : `Create ${label}`}
        </Button>
      </DialogFooter>
    </>
  );
}
