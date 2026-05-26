"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
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

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lowercase singular entity, e.g. "location", "user" — drives title + toasts. */
  entityLabel: string;
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Reusable confirmation for a soft delete: stays open on error, closes on
 * success. The shared replacement for the per-entity delete dialogs — pass the
 * entity label, the record name and a `mutateAsync` thunk. See ADR-0020.
 */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  entityLabel,
  name,
  onConfirm,
  children,
  onDeleted,
}: DeleteConfirmDialogProps) {
  const [isPending, setIsPending] = useState(false);

  async function handleDelete() {
    setIsPending(true);
    try {
      await onConfirm();
      toast.success(`${capitalize(entityLabel)} deleted`);
      onOpenChange(false);
      onDeleted?.();
    } catch (error) {
      notifyError(error, `Couldn't delete ${entityLabel}`);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {entityLabel}?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{name}</span> will be
            archived — a soft delete that hides it from the list without erasing
            its history.{children ? <> {children}</> : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          {/* Plain destructive button (not AlertDialogAction) so we control the
              pending spinner and only close on success. */}
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending}
          >
            {isPending && <ArrowPathIcon className="animate-spin" />}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
