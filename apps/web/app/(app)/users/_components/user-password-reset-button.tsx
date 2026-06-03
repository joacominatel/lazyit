"use client";

import { ArrowPathIcon, KeyIcon } from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
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
import { ApiError } from "@/lib/api/client";
import { useResetUserPassword } from "@/lib/api/hooks/use-user-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";

interface UserPasswordResetButtonProps {
  /** The user whose password reset is being triggered. */
  user: User;
}

/**
 * "Send password reset" action on the user detail page. Asks the identity provider (Zitadel) to email
 * the user a reset link via ITS SMTP (`POST /users/:id/reset-password`) — lazyit never sees or sets the
 * password. Gated on `user:manage` (fails closed while the permission set loads).
 *
 * The reset is only meaningful for an active, IdP-linked account, so we DISABLE the action — with an
 * explanatory `title` — when we can already tell it would fail:
 *   - the user has no IdP link (`externalId == null`) → the API would 501 ("managed by your IdP");
 *   - the user is inactive (offboarded) → the API would 422.
 * For every other case we fire the request and map the honest non-success statuses on the
 * {@link ApiError}: **204** success, **501** managed-by-IdP, **422** inactive, **404** generic.
 * Delivery still depends on the IdP's SMTP being configured.
 */
export function UserPasswordResetButton({ user }: UserPasswordResetButtonProps) {
  const canManage = useCan("user:manage");
  const resetPassword = useResetUserPassword();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Fail closed: render nothing until we positively know the caller may manage users.
  if (!canManage) return null;

  // The two cases we can detect client-side and pre-empt, rather than firing a request we know fails.
  const hasNoIdpLink = user.externalId == null;
  const isInactive = !user.isActive;
  const disabledReason = hasNoIdpLink
    ? "This account has no identity-provider link, so password reset is managed by your identity provider."
    : isInactive
      ? "This user is inactive — reactivate them before sending a password reset."
      : null;
  const disabled = disabledReason != null;

  function handleConfirm() {
    resetPassword.mutate(user.id, {
      onSuccess: () => {
        toast.success("Password reset email sent via the identity provider", {
          description:
            "Delivery depends on your identity provider's SMTP being configured.",
        });
        setConfirmOpen(false);
      },
      // Map the honest non-success statuses to clear copy; everything else falls back to notifyError
      // (which surfaces the API message + request id). We keep the dialog open so the operator sees why.
      onError: (error) => {
        if (error instanceof ApiError && error.status === 501) {
          toast.info("Password reset is managed by your identity provider", {
            description:
              "lazyit can't drive a reset for this account — manage the password in your IdP.",
          });
          setConfirmOpen(false);
          return;
        }
        if (error instanceof ApiError && error.status === 422) {
          toast.error("This user is inactive", {
            description: "Reactivate them before sending a password reset.",
          });
          setConfirmOpen(false);
          return;
        }
        notifyError(error, "Couldn't send the password reset");
        setConfirmOpen(false);
      },
    });
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        disabled={disabled}
        title={disabledReason ?? undefined}
      >
        <KeyIcon />
        Send password reset
      </Button>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send a password reset?</AlertDialogTitle>
            <AlertDialogDescription>
              Your identity provider will email{" "}
              <span className="font-medium text-foreground">{user.email}</span> a
              link to reset their password. lazyit never sees or sets the
              password; delivery depends on the provider&apos;s SMTP being
              configured.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetPassword.isPending}>
              Cancel
            </AlertDialogCancel>
            {/* Plain button (not AlertDialogAction) so we own the spinner and only close on resolve. */}
            <Button
              onClick={handleConfirm}
              disabled={resetPassword.isPending}
            >
              {resetPassword.isPending && (
                <ArrowPathIcon className="animate-spin" />
              )}
              Send reset email
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
