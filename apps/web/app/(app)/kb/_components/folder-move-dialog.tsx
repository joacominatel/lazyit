"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUpdateArticleCategory } from "@/lib/api/hooks/use-article-categories";
import { notifyError } from "@/lib/api/notify-error";
import { folderMutationErrorKind } from "@/lib/utils/folder-mutation-error";
import type { FolderPathOption } from "@/lib/utils/folder-tree";

/**
 * The Select value standing for "no parent". Radix `SelectItem` rejects an empty string value, so the
 * root option needs a sentinel; it is translated back to the wire's `parentId: null` on submit.
 */
const ROOT_VALUE = "__root__";

/**
 * FolderMoveDialog — reparent a folder from the KB tree's "⋯ → Move to…" (#1291). Destinations are
 * every other live folder, labelled by their FULL path so a repeated leaf name is unambiguous, plus
 * a "Top level" option that sends `parentId: null`.
 *
 * A menu-driven move rather than drag-and-drop: it is keyboard-operable, and it leaves the tree's
 * existing `role="tree"` keyboard navigation untouched.
 *
 * The destination list is deliberately NOT pruned of the folder's own descendants. The cycle rule
 * lives in the API's DFS guard (ADR-0059 §1) and re-deriving it here would create a second, drifting
 * copy of it; instead an attempted cycle comes back as a 400 and is reported as its own sentence.
 * The only id removed is the folder itself, which the Select could not meaningfully offer.
 */
export function FolderMoveDialog({
  open,
  onOpenChange,
  folderId,
  folderName,
  currentParentId,
  options,
  onMoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string;
  folderName: string;
  /** Where the folder lives today — `null` when it is already a root folder. */
  currentParentId: string | null;
  /** Every candidate destination (the folder itself already excluded), path-labelled and sorted. */
  options: FolderPathOption[];
  /** Called with the new parent id (`null` = root) so the tree can reveal the moved folder. */
  onMoved?: (newParentId: string | null) => void;
}) {
  const t = useTranslations("kb");
  const tc = useTranslations("common");
  const update = useUpdateArticleCategory();
  // Seeded with the CURRENT parent, so the dialog states where the folder is before it moves. The
  // tree mounts this dialog only while it is open, so initial state IS the per-open reset — no
  // effect, and a reopen can never show a stale destination or a stale error.
  const [value, setValue] = useState<string>(currentParentId ?? ROOT_VALUE);
  const [error, setError] = useState<string | null>(null);

  function handleMove() {
    const nextParentId = value === ROOT_VALUE ? null : value;
    if (nextParentId === currentParentId) {
      setError(t("folders.move.unchanged"));
      return;
    }
    setError(null);
    update.mutate(
      { id: folderId, data: { parentId: nextParentId } },
      {
        onSuccess: () => {
          toast.success(t("folders.move.moved", { name: folderName }));
          onOpenChange(false);
          onMoved?.(nextParentId);
        },
        onError: (err) => {
          // The API's three rejections each get their own sentence, inline on the picker where the
          // user chooses the destination. Anything else falls back to the server's own message.
          const kind = folderMutationErrorKind(err);
          if (kind === "cycle") {
            setError(t("folders.errors.cycle"));
            return;
          }
          if (kind === "deadParent") {
            setError(t("folders.errors.deadParent"));
            return;
          }
          if (kind === "duplicateName") {
            setError(t("folders.errors.duplicateInDestination"));
            return;
          }
          notifyError(err, t("folders.move.error"));
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("folders.move.title")}</DialogTitle>
          <DialogDescription>
            {t("folders.move.description", { name: folderName })}
          </DialogDescription>
        </DialogHeader>

        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="kb-folder-move-parent">
            {t("folders.move.parentLabel")}
          </FieldLabel>
          <Select
            value={value}
            onValueChange={(next) => {
              setValue(next);
              if (error) setError(null);
            }}
          >
            <SelectTrigger
              id="kb-folder-move-parent"
              className="w-full"
              aria-invalid={error ? true : undefined}
            >
              <SelectValue placeholder={t("folders.move.parentPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROOT_VALUE}>
                {t("folders.move.root")}
              </SelectItem>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError>{error}</FieldError>
        </Field>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={update.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="button" onClick={handleMove} disabled={update.isPending}>
            {update.isPending ? <ArrowPathIcon className="animate-spin" /> : null}
            {t("folders.move.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
