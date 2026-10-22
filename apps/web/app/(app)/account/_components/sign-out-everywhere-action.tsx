"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useSecretSession } from "@/app/(app)/secrets/_components/secret-session";
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
import { useSignOutEverywhere } from "@/lib/api/hooks/use-my-sessions";
import { notifyError } from "@/lib/api/notify-error";
import { signOutLocally } from "@/lib/auth/sign-out";
import type { PasswordOwner } from "../_lib/account-sections";

/** Which copy variant a password owner reads (the API without `authMode` gets the generic one). */
function copyKey(owner: PasswordOwner): "local" | "identityProvider" | "unknown" {
  if (owner === "lazyit") return "local";
  if (owner === "identity-provider") return "identityProvider";
  return "unknown";
}

/**
 * "Sign out everywhere and disconnect AI apps" (#1699, CEO decision on #1344 Q4) — the explicit,
 * account-wide revocation, shown in every auth mode. It asks first (it cannot be undone), then
 * `POST /auth/sessions/revoke-all` ends every session of the user and disconnects every AI app and
 * personal token; this browser's token is dead at that point, so it signs out here the way ending this
 * device does — lock the in-memory secret session (#512), drop the cookie, land on /login — without the
 * plain `POST /auth/logout`, which has nothing left to do.
 *
 * The plain sign-out next to it is unchanged: it ends web sessions only and leaves AI apps connected.
 * A failed request changes nothing and leaves the user signed in to retry; a 401 (already revoked
 * elsewhere) takes the global auth-expiry path.
 */
export function SignOutEverywhereAction({ owner }: { owner: PasswordOwner }) {
  const t = useTranslations("account.hub.security.disconnectAll");
  const revoke = useSignOutEverywhere();
  const { lock } = useSecretSession();
  const [open, setOpen] = useState(false);
  // Keeps the spinner up from the request through the navigation to /login.
  const [signingOut, setSigningOut] = useState(false);
  const busy = revoke.isPending || signingOut;
  const variant = copyKey(owner);

  async function handleConfirm() {
    try {
      await revoke.mutateAsync();
    } catch (error) {
      notifyError(error, t("error"));
      return;
    }
    setSigningOut(true);
    lock();
    await signOutLocally();
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-sm text-muted-foreground">
          {t(`description.${variant}`)}
        </p>
      </div>
      <Button
        variant="destructive"
        size="sm"
        className="shrink-0"
        onClick={() => setOpen(true)}
        disabled={busy}
      >
        {t("button")}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(`confirm.description.${variant}`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("confirm.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={busy}
            >
              {busy && <ArrowPathIcon className="animate-spin" />}
              {t("confirm.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
