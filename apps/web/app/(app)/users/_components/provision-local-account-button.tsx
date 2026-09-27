"use client";

import { ArrowPathIcon, KeyIcon } from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useProvisionLocalUserAccount } from "@/lib/api/hooks/use-user-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { TemporaryPasswordReveal } from "./temporary-password-reveal";

/**
 * Local-mode onboarding (ADR-0086 §5 amendment, issue #1072) — the counterpart to the OIDC
 * {@link ProvisionAccountButton} when `AUTH_MODE=local`. After a bulk import every person lands as a
 * login-less directory row and, in local mode, ALL self-service onboarding paths are closed by
 * construction. So an ADMIN explicitly mints a ONE-TIME temporary password here: the person becomes a
 * real login account (keeping their role — no privilege widening) and must change the password at first
 * sign-in. Rendered only for a directory person, only in local mode (gated upstream by
 * `canProvisionLocalAccounts`); the caller already gates on `user:manage`.
 *
 * The temp password is returned by the API exactly ONCE and is never refetchable, so on success we reveal
 * it INLINE through the shared {@link TemporaryPasswordReveal} — copy-to-clipboard plus an explicit
 * acknowledgement to dismiss (the same presentation the admin password reset uses, #1268). It lives only
 * in this component's state — never the cache.
 */
export function ProvisionLocalAccountButton({ user }: { user: User }) {
  const t = useTranslations("users");
  const provision = useProvisionLocalUserAccount();
  // The minted temp password, shown ONCE. Lives only here — deliberately never the TanStack cache.
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  function handleClick() {
    provision.mutate(user.id, {
      onSuccess: (result) => {
        setTempPassword(result.temporaryPassword);
        toast.success(
          t("directory.provisionLocal.success", {
            name: `${user.firstName} ${user.lastName}`,
          }),
        );
      },
      onError: (error) => notifyError(error, t("directory.provisionLocal.error")),
    });
  }

  if (tempPassword) {
    return (
      <TemporaryPasswordReveal
        password={tempPassword}
        message={t.rich("directory.provisionLocal.reveal.message", {
          name: `${user.firstName} ${user.lastName}`,
          b: (chunks) => (
            <span className="font-medium text-foreground">{chunks}</span>
          ),
        })}
        onDone={() => setTempPassword(null)}
      />
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={provision.isPending}
    >
      {provision.isPending ? (
        <ArrowPathIcon className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <KeyIcon aria-hidden="true" />
      )}
      {t("directory.provisionLocal.action")}
    </Button>
  );
}
