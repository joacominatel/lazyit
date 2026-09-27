"use client";

import { ArrowPathIcon, KeyIcon } from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
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
import { ApiError } from "@/lib/api/client";
import { useResetUserPassword } from "@/lib/api/hooks/use-user-mutations";
import { usePasswordResetCapabilities } from "@/lib/api/hooks/use-users";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { LocalPasswordResetDialog } from "./local-password-reset-dialog";

interface UserPasswordResetButtonProps {
  /** The user whose password reset is being triggered. */
  user: User;
}

/**
 * "Send password reset" action on the user detail page, gated on `user:manage` (fails closed while the
 * permission set loads). What it DOES depends on who owns the credential, which the server tells us via
 * `GET /users/password-reset-capabilities` (issue #1268) — never inferred from `externalId`:
 *
 *   - **OIDC / bundled Zitadel** (the default here, and what an older API implies): ask the identity
 *     provider to email the reset link via ITS SMTP (`POST /users/:id/reset-password`, 204) — lazyit
 *     never sees or sets the password. Unchanged from before #1268, down to the copy.
 *   - **`AUTH_MODE=local`** (`canResetLocally`): lazyit owns the credential, so the action opens the
 *     {@link LocalPasswordResetDialog} where the admin picks the delivery (email a reset link vs. mint a
 *     temporary password).
 *
 * The pre-emptive disable differs by mode, because the reasons a reset would fail differ:
 *   - **OIDC** — no IdP link (`externalId == null`) → the API would 501; inactive → 422. This gate is
 *     right there and stays. It was the #1268 BUG only because it also ran in local mode, where
 *     `externalId` is null for every user by construction, permanently disabling the action.
 *   - **local** — inactive → 422; a directory person has no login account at all, so they must be
 *     onboarded (which mints their first password) rather than "reset".
 *
 * The capabilities read fails SOFT: while it is loading, or if it 403s/404s (an API older than #1268),
 * we render exactly the pre-#1268 OIDC behavior rather than breaking the page.
 */
export function UserPasswordResetButton({ user }: UserPasswordResetButtonProps) {
  const t = useTranslations("users.passwordReset");
  const tc = useTranslations("common");
  const canManage = useCan("user:manage");
  const capabilities = usePasswordResetCapabilities({ enabled: canManage });
  const resetPassword = useResetUserPassword();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Fail closed: render nothing until we positively know the caller may manage users.
  if (!canManage) return null;

  const isLocal = capabilities.data?.canResetLocally === true;
  const isInactive = !user.isActive;

  // The cases we can detect client-side and pre-empt, rather than firing a request we know fails.
  const disabledReason = isLocal
    ? isInactive
      ? t("disabledInactive")
      : user.directoryOnly
        ? t("disabledDirectoryOnly")
        : null
    : user.externalId == null
      ? t("disabledNoIdp")
      : isInactive
        ? t("disabledInactive")
        : null;
  const disabled = disabledReason != null;

  function handleConfirm() {
    resetPassword.mutate(
      { id: user.id },
      {
        onSuccess: () => {
          toast.success(t("toast.sentTitle"), {
            description: t("toast.sentDescription"),
          });
          setConfirmOpen(false);
        },
        // Map the honest non-success statuses to clear copy; everything else falls back to notifyError
        // (which surfaces the API message + request id). We keep the dialog open so the operator sees why.
        onError: (error) => {
          if (error instanceof ApiError && error.status === 501) {
            toast.info(t("toast.managedTitle"), {
              description: t("toast.managedDescription"),
            });
            setConfirmOpen(false);
            return;
          }
          if (error instanceof ApiError && error.status === 422) {
            toast.error(t("toast.inactiveTitle"), {
              description: t("toast.inactiveDescription"),
            });
            setConfirmOpen(false);
            return;
          }
          notifyError(error, t("toast.error"));
          setConfirmOpen(false);
        },
      },
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        disabled={disabled}
        title={disabledReason ?? undefined}
        className="border-warning/40 hover:border-warning/70 hover:bg-warning/5"
      >
        {/* Amber key cues a sensitive (but non-destructive) security action — distinct from the
            red Offboard, and the label stays on --foreground so contrast holds. */}
        <KeyIcon className="text-warning" />
        {t("button")}
      </Button>

      {isLocal && capabilities.data ? (
        <LocalPasswordResetDialog
          user={user}
          capabilities={capabilities.data}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
        />
      ) : (
        <AlertDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            if (!open) setConfirmOpen(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t.rich("confirmBody", {
                  email: user.email,
                  strong: (chunks) => (
                    <span className="font-medium text-foreground">{chunks}</span>
                  ),
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={resetPassword.isPending}>
                {tc("cancel")}
              </AlertDialogCancel>
              {/* Plain button (not AlertDialogAction) so we own the spinner and only close on resolve. */}
              <Button onClick={handleConfirm} disabled={resetPassword.isPending}>
                {resetPassword.isPending && (
                  <ArrowPathIcon className="animate-spin" />
                )}
                {t("send")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
