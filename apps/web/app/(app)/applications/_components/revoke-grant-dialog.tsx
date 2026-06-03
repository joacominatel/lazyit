"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
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
import { useCan } from "@/lib/hooks/use-permissions";
import { notifyError } from "@/lib/api/notify-error";

interface RevokeGrantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Grantee name, shown in the prompt. */
  userName: string;
  /** Optional access level, for context. */
  accessLevel?: string | null;
  /** Revoke thunk — typically `() => revokeGrant.mutateAsync({ id })`. */
  onConfirm: () => Promise<unknown>;
}

/**
 * Confirmation for revoking an access grant. Mirrors {@link DeleteConfirmDialog} (stays open on
 * error, closes on success, owns the spinner + toasts) but with revoke semantics: the grant is kept
 * in history — this ends it, it is not a deletion. Surfaces the API's 409 ("already revoked") via the
 * error toast.
 */
export function RevokeGrantDialog({
  open,
  onOpenChange,
  userName,
  accessLevel,
  onConfirm,
}: RevokeGrantDialogProps) {
  const canGrant = useCan("accessGrant:grant");
  const [isPending, setIsPending] = useState(false);

  async function handleRevoke() {
    setIsPending(true);
    try {
      await onConfirm();
      toast.success("Access revoked");
      onOpenChange(false);
    } catch (error) {
      notifyError(error, "Couldn't revoke access");
    } finally {
      setIsPending(false);
    }
  }

  // RBAC v2: revoking a grant is an AccessGrant mutation gated on `accessGrant:grant` (ADR-0046).
  // Render nothing without it so the affordance never appears; the API's permission guard is the real
  // gate (fails closed).
  if (!canGrant) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke access?</AlertDialogTitle>
          <AlertDialogDescription>
            Revoke this grant for{" "}
            <span className="font-medium text-foreground">{userName}</span>
            {accessLevel ? ` (${accessLevel})` : ""}. The grant is kept in
            history — revoking ends it, it is not a deletion.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleRevoke}
            disabled={isPending}
          >
            {isPending && <ArrowPathIcon className="animate-spin" />}
            Revoke
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
