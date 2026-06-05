"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/api/notify-error";
import type { EntityKey } from "@/lib/entity-key";

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Stable entity key from the closed set ({@link EntityKey}) — the dialog resolves the localized,
   * correctly-pluralized/gendered noun internally for the title + toasts (issue #204). Never a raw
   * English word.
   */
  entityKey: EntityKey;
  /** Human-readable record name, shown in bold in the prompt. */
  name: string;
  /**
   * Performs the (soft) delete; resolves on success, rejects on error —
   * typically `() => deleteX.mutateAsync(id)`. The dialog owns the spinner,
   * the success/error toasts and closing, so callers don't re-implement them.
   * Taking a thunk (not the raw mutation) keeps this decoupled from TanStack's
   * generics and fully type-safe.
   */
  onConfirm: () => Promise<unknown>;
  /** Extra explanatory copy rendered after the default soft-delete sentence. */
  children?: ReactNode;
  /** Side effect to run after a successful delete (e.g. clear a selection). */
  onDeleted?: () => void;
}

/**
 * Reusable confirmation for a soft delete: stays open on error, closes on
 * success. The shared replacement for the per-entity delete dialogs — pass the
 * entity key, the record name and a `mutateAsync` thunk. See ADR-0020.
 */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  entityKey,
  name,
  onConfirm,
  children,
  onDeleted,
}: DeleteConfirmDialogProps) {
  const t = useTranslations("shared");
  const [isPending, setIsPending] = useState(false);

  async function handleDelete() {
    setIsPending(true);
    try {
      await onConfirm();
      toast.success(t("dialog.deleted", { entity: entityKey }));
      onOpenChange(false);
      onDeleted?.();
    } catch (error) {
      notifyError(error, t("dialog.deleteError", { entity: entityKey }));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("dialog.deleteTitle", { entity: entityKey })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{name}</span>{" "}
            {t("dialog.deleteDescriptionPrefix")}
            {children ? <> {children}</> : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            {t("dialog.cancel")}
          </AlertDialogCancel>
          {/* Plain destructive button (not AlertDialogAction) so we control the
              pending spinner and only close on success. */}
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending}
          >
            {isPending && <ArrowPathIcon className="animate-spin" />}
            {t("dialog.delete")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
