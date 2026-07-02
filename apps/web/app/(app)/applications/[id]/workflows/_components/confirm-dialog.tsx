"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslations } from "next-intl";

/**
 * A small confirm dialog for the workflow surfaces. The shared {@link DeleteConfirmDialog} resolves its
 * noun from the closed {@link EntityKey} set (which does not include the workflow entities); rather than
 * grow that cross-namespace ICU table, the workflow lane uses this self-contained confirm with copy from
 * its own `workflow` namespace. Awaits `onConfirm` and closes on success.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const tc = useTranslations("common");
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // Swallow: a rejected `onConfirm` must NOT propagate as an unhandled promise rejection
      // (issue #938). The dialog intentionally stays open (mirrors DeleteConfirmDialog) so the
      // user can retry; the failure itself is surfaced by the caller — either the underlying
      // mutation's own `onError` (e.g. `useDeleteWorkflowConnection`) or an explicit try/catch +
      // `notifyError` in `onConfirm` (see ReplayLatestButton, which also needs specific per-status
      // copy and would otherwise get a second, generic toast here).
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {tc("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
