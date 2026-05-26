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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CategoryKind, CreatedCategory } from "@/lib/api/endpoints/categories";
import { useCreateCategory } from "@/lib/api/hooks/use-create-category";
import { notifyError } from "@/lib/api/notify-error";

const LABEL: Record<CategoryKind, string> = {
  asset: "asset category",
  application: "application category",
  consumable: "consumable category",
  article: "article category",
};

interface CreateCategoryDialogProps {
  kind: CategoryKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created category so the caller can select it. */
  onCreated?: (category: CreatedCategory) => void;
}

/**
 * Quick-create for a category (any of the four kinds), used by the inline "+ New" on category
 * selects. Collects only a name — the shared field across all category schemas; richer attributes
 * stay editable via the API/seed. Issue #25.
 */
export function CreateCategoryDialog({
  kind,
  open,
  onOpenChange,
  onCreated,
}: CreateCategoryDialogProps) {
  const create = useCreateCategory(kind);
  const [name, setName] = useState("");

  function handleOpenChange(next: boolean) {
    if (!next) setName("");
    onOpenChange(next);
  }

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Enter a name");
      return;
    }
    create.mutate(trimmed, {
      onSuccess: (category) => {
        toast.success("Category created");
        onCreated?.(category);
        handleOpenChange(false);
      },
      onError: (error) =>
        notifyError(error, "Couldn't create the category"),
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New {LABEL[kind]}</DialogTitle>
          <DialogDescription>
            Create a category to use it right away. You can refine it later.
          </DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor="new-category-name">Name</FieldLabel>
          <Input
            id="new-category-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleCreate();
              }
            }}
            placeholder="e.g. Laptops"
            autoFocus
          />
        </Field>

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
