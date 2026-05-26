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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAssetCategories } from "@/lib/api/hooks/use-asset-categories";
import { useCreateAssetModel } from "@/lib/api/hooks/use-asset-models";

/** Radix Select forbids an empty-string item value; sentinel for "no category". */
const NONE = "__none__";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface CreateAssetModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created model so the caller can select it. */
  onCreated?: (model: AssetModel) => void;
}

/**
 * Quick-create for an AssetModel, used by the inline "+ New" on the asset form's model select.
 * Collects name + manufacturer (both required) and an optional category. The asset category is a
 * plain select here — making it creatable too would nest a dialog inside this one (deferred). Issue
 * #25.
 */
export function CreateAssetModelDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateAssetModelDialogProps) {
  const { data: categories } = useAssetCategories();
  const create = useCreateAssetModel();
  const [name, setName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [categoryId, setCategoryId] = useState("");

  function handleOpenChange(next: boolean) {
    if (!next) {
      setName("");
      setManufacturer("");
      setCategoryId("");
    }
    onOpenChange(next);
  }

  function handleCreate() {
    const trimmedName = name.trim();
    const trimmedManufacturer = manufacturer.trim();
    if (!trimmedName || !trimmedManufacturer) {
      toast.error("Name and manufacturer are required");
      return;
    }
    create.mutate(
      {
        name: trimmedName,
        manufacturer: trimmedManufacturer,
        ...(categoryId ? { categoryId } : {}),
      },
      {
        onSuccess: (model) => {
          toast.success("Model created");
          onCreated?.(model);
          handleOpenChange(false);
        },
        onError: (error) =>
          toast.error(errorMessage(error, "Couldn't create the model")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New model</DialogTitle>
          <DialogDescription>
            Create a make/model to use it right away. You can refine it later.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="new-model-name">Name</FieldLabel>
            <Input
              id="new-model-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Latitude 5520"
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-model-manufacturer">Manufacturer</FieldLabel>
            <Input
              id="new-model-manufacturer"
              value={manufacturer}
              onChange={(event) => setManufacturer(event.target.value)}
              placeholder="Dell"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-model-category">Category</FieldLabel>
            <Select
              value={categoryId || NONE}
              onValueChange={(value) =>
                setCategoryId(value === NONE ? "" : value)
              }
            >
              <SelectTrigger id="new-model-category" className="w-full">
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
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleCreate} disabled={create.isPending}>
            {create.isPending && <ArrowPathIcon className="animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
