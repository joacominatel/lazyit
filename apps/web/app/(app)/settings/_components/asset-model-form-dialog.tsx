"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { AssetModel } from "@lazyit/shared";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAssetCategories } from "@/lib/api/hooks/use-asset-categories";
import {
  useCreateAssetModel,
  useUpdateAssetModel,
} from "@/lib/api/hooks/use-asset-models";
import { notifyError } from "@/lib/api/notify-error";

const FORM_ID = "asset-model-form";
const NO_CATEGORY = "__none__";

interface FormState {
  name: string;
  manufacturer: string;
  sku: string;
  description: string;
  categoryId: string;
}

function toFormState(model?: AssetModel): FormState {
  return {
    name: model?.name ?? "",
    manufacturer: model?.manufacturer ?? "",
    sku: model?.sku ?? "",
    description: model?.description ?? "",
    categoryId: model?.categoryId ?? "",
  };
}

type BuildResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

interface AssetModelFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit that model; absent → create a new one. */
  model?: AssetModel;
}

/**
 * Create/edit dialog for an Asset model in the Settings → Taxonomies area. New component (does NOT
 * touch the existing inline `create-asset-model-dialog`). The thin wrapper owns the `<Dialog>`; the
 * body is a keyed inner component so it remounts with fresh state per target model (no
 * setState-in-effect). Name + manufacturer are required; SKU, description and the owning asset
 * category are optional. Specs are out of scope here (edited via the API/seed).
 */
export function AssetModelFormDialog({
  open,
  onOpenChange,
  model,
}: AssetModelFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <AssetModelForm
            key={model?.id ?? "new"}
            model={model}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AssetModelForm({
  model,
  onClose,
}: {
  model?: AssetModel;
  onClose: () => void;
}) {
  const isEdit = model != null;
  const create = useCreateAssetModel();
  const update = useUpdateAssetModel();
  const { data: categories } = useAssetCategories();
  const isPending = create.isPending || update.isPending;

  const [values, setValues] = useState<FormState>(() => toFormState(model));
  const [error, setError] = useState<string | undefined>(undefined);

  function set<K extends keyof FormState>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function buildPayload(): BuildResult {
    const name = values.name.trim();
    const manufacturer = values.manufacturer.trim();
    if (name.length === 0) return { ok: false, error: "Name is required." };
    if (manufacturer.length === 0) {
      return { ok: false, error: "Manufacturer is required." };
    }

    const sku = values.sku.trim();
    const description = values.description.trim();

    const payload: Record<string, unknown> = { name, manufacturer };
    if (sku.length > 0) payload.sku = sku;
    if (description.length > 0) payload.description = description;
    if (values.categoryId.length > 0) payload.categoryId = values.categoryId;
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
            toast.success("Asset model updated");
            onClose();
          },
          onError: (err) => notifyError(err, "Couldn't update asset model"),
        },
      );
    } else {
      create.mutate(built.payload as never, {
        onSuccess: () => {
          toast.success("Asset model created");
          onClose();
        },
        onError: (err) => notifyError(err, "Couldn't create asset model"),
      });
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEdit ? "Edit asset model" : "New asset model"}
        </DialogTitle>
        <DialogDescription>
          {isEdit
            ? "Update this make/model. Specs are managed via the API."
            : "A generic make/model that assets are instances of, e.g. “Dell Latitude 5520”."}
        </DialogDescription>
      </DialogHeader>

      <form id={FORM_ID} onSubmit={handleSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="model-name">Name</FieldLabel>
            <Input
              id="model-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Latitude 5520"
              maxLength={200}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
          </Field>

          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="model-manufacturer">Manufacturer</FieldLabel>
            <Input
              id="model-manufacturer"
              value={values.manufacturer}
              onChange={(e) => set("manufacturer", e.target.value)}
              placeholder="Dell"
              maxLength={200}
              aria-invalid={error ? true : undefined}
            />
            {error ? <FieldError errors={[{ message: error }]} /> : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="model-sku">SKU</FieldLabel>
            <Input
              id="model-sku"
              value={values.sku}
              onChange={(e) => set("sku", e.target.value)}
              placeholder="Optional — unique part/SKU"
              maxLength={100}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="model-category">Category</FieldLabel>
            <Select
              value={values.categoryId || NO_CATEGORY}
              onValueChange={(value) =>
                set("categoryId", value === NO_CATEGORY ? "" : value)
              }
            >
              <SelectTrigger id="model-category" className="w-full">
                <SelectValue placeholder="Optional — pick a category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>No category</SelectItem>
                {(categories ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="model-description">Description</FieldLabel>
            <Textarea
              id="model-description"
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Optional"
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
          Cancel
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit ? "Save changes" : "Create model"}
        </Button>
      </DialogFooter>
    </>
  );
}
