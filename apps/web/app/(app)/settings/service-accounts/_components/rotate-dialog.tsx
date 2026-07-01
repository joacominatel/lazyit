"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { ServiceAccount } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/api/notify-error";
import { useRotateServiceAccount } from "@/lib/api/hooks/use-service-accounts";
import { SaKeypairSetup } from "./sa-keypair-setup";
import { SecretReveal } from "./secret-reveal";

interface RotateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: ServiceAccount;
}

/**
 * Rotate the token for one service account (ADR-0048). A two-step flow in a single dialog:
 *   1. a confirm warning that the OLD token stops working immediately;
 *   2. on confirm, the rotate mutation runs and the dialog swaps to the one-time {@link SecretReveal}
 *      showing the NEW token (from the mutation result — never cached, never refetchable).
 *
 * Body is keyed on the account id so reopening for a different row resets the confirm/secret state.
 */
export function RotateDialog({ open, onOpenChange, account }: RotateDialogProps) {
  // The new token is shown once; while it is unacknowledged the reveal locks the dialog against
  // accidental dismissal (Escape / overlay-click / close button) so it cannot be lost (issue #813).
  const [locked, setLocked] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (locked && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!locked}
        onEscapeKeyDown={locked ? (e) => e.preventDefault() : undefined}
        onInteractOutside={locked ? (e) => e.preventDefault() : undefined}
      >
        {open ? (
          <RotateBody
            key={account.id}
            account={account}
            onClose={() => onOpenChange(false)}
            onLockChange={setLocked}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RotateBody({
  account,
  onClose,
  onLockChange,
}: {
  account: ServiceAccount;
  onClose: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const rotate = useRotateServiceAccount();
  const [token, setToken] = useState<string | null>(null);

  function handleRotate() {
    rotate.mutate(account.id, {
      onSuccess: (result) => {
        toast.success(t("serviceAccounts.toast.rotated"));
        setToken(result.token);
      },
      onError: (err) => notifyError(err, t("serviceAccounts.toast.rotateError")),
    });
  }

  if (token) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("serviceAccounts.rotate.secretTitle")}</DialogTitle>
          <DialogDescription>
            {t("serviceAccounts.rotate.secretDescription")}
          </DialogDescription>
        </DialogHeader>
        <SecretReveal
          name={account.name}
          token={token}
          action="rotated"
          onAcknowledge={onClose}
          permissions={account.permissions}
          onLockedChange={onLockChange}
        />
        {/* ADR-0080 (#883): rotation invalidates the old token, so the keypair wrapped under it is dead.
            Re-generate the keypair under the NEW token (client-side) and replace the stored one — this also
            retrofits a pre-#883 keyless SA. Replacing the keypair drops the SA's vault grants (re-grant). */}
        <SaKeypairSetup saId={account.id} token={token} />
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("serviceAccounts.rotate.confirmTitle")}</DialogTitle>
        <DialogDescription>
          {t.rich("serviceAccounts.rotate.confirmDescription", {
            name: account.name,
            b: (chunks) => (
              <span className="font-medium text-foreground">{chunks}</span>
            ),
          })}
        </DialogDescription>
      </DialogHeader>

      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={rotate.isPending}
        >
          {tc("cancel")}
        </Button>
        <Button type="button" onClick={handleRotate} disabled={rotate.isPending}>
          {rotate.isPending && <ArrowPathIcon className="animate-spin" />}
          {t("serviceAccounts.rotate.rotateButton")}
        </Button>
      </div>
    </>
  );
}
