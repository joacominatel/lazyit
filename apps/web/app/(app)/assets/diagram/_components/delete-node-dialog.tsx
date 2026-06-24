"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
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

interface DeleteNodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The node's label, shown in the prompt. */
  label: string;
  /** Soft-delete thunk — typically `() => removeNode.mutateAsync(id)`. */
  onConfirm: () => Promise<unknown>;
}

/**
 * Confirmation for taking a node OFF the map (soft-delete — history kept, restorable). Mirrors the
 * app's delete-confirm pattern (stays open on error, closes + toasts on success, owns the spinner).
 * The caller gates rendering on `infra:manage`; the API's permission guard is the real gate.
 */
export function DeleteNodeDialog({
  open,
  onOpenChange,
  label,
  onConfirm,
}: DeleteNodeDialogProps) {
  const t = useTranslations("infra");
  const tc = useTranslations("common");
  const [isPending, setIsPending] = useState(false);

  async function handleDelete() {
    setIsPending(true);
    try {
      await onConfirm();
      toast.success(t("delete.removedToast"));
      onOpenChange(false);
    } catch (error) {
      notifyError(error, t("delete.error"));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("delete.descriptionPrefix")}
            <span className="font-medium text-foreground">{label}</span>
            {t("delete.descriptionSuffix")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            {tc("cancel")}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending}
          >
            {isPending && <ArrowPathIcon className="animate-spin" />}
            {t("delete.submit")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
