"use client";

import { ArrowPathIcon, KeyIcon } from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { useProvisionUserAccount } from "@/lib/api/hooks/use-user-mutations";

/**
 * The manual "Create OIDC account" promotion (ADR-0069 REDESIGN §0 #3) — the explicit counterpart to the
 * auto-claim-by-verified-email login (ADR-0038). For a directory person (no login, created by the bulk
 * import) an ADMIN can provision their account in the identity provider right now. Rendered ONLY for a
 * directory person; the caller already gates on `user:manage` (the same coarse capability behind every
 * other admin user action), so this component doesn't re-check the permission.
 *
 * Zitadel requires a real email, so:
 *   - When the person has no real email — missing, or the synthesized `…@directory.local` placeholder the
 *     import mints when a row has no email — we pre-disable the button and show the "needs an email" hint
 *     inline (no point firing a request we know will 400).
 *   - The backend is still the source of truth: a 400 (not a directory person / already linked / no email)
 *     is surfaced inline (`role=alert`), never as a silent failure — robust even if the client check above
 *     missed an edge.
 *   - Any other failure (e.g. 503 the IdP create failed) is an error toast.
 * On success the person becomes a real account (the "Directory" badge disappears on refetch) and we toast.
 */

// ponytail: the placeholder domain is a backend constant (DIRECTORY_PLACEHOLDER_EMAIL_DOMAIN in
// users.service.ts) that isn't exported through @lazyit/shared, so we mirror the suffix here. It only
// pre-disables the button for a nicer UX — the backend's 400 is still the authority if this drifts.
const DIRECTORY_PLACEHOLDER_EMAIL_DOMAIN = "@directory.local";

export function ProvisionAccountButton({ user }: { user: User }) {
  const t = useTranslations("users");
  const provision = useProvisionUserAccount();
  // The inline 400 message (server says this person can't be promoted as-is, usually a missing email).
  const [inlineError, setInlineError] = useState<string | null>(null);

  // No real email → no Zitadel account. Pre-disable + hint (the backend still 400s as the authority).
  const lacksRealEmail =
    !user.email || user.email.endsWith(DIRECTORY_PLACEHOLDER_EMAIL_DOMAIN);

  function handleClick() {
    setInlineError(null);
    provision.mutate(user.id, {
      onSuccess: () =>
        toast.success(
          t("directory.provision.success", {
            name: `${user.firstName} ${user.lastName}`,
          }),
        ),
      onError: (error) => {
        // A 400 means this person can't be promoted as mapped (no real email / not a directory person /
        // already linked) — show it inline next to the button so the operator can act on it, rather than
        // a transient toast. Everything else is an unexpected failure → error toast.
        if (error instanceof ApiError && error.status === 400) {
          setInlineError(t("directory.provision.needsEmail"));
        } else {
          toast.error(t("directory.provision.error"));
        }
      },
    });
  }

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={provision.isPending || lacksRealEmail}
      >
        {provision.isPending ? (
          <ArrowPathIcon className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <KeyIcon aria-hidden="true" />
        )}
        {t("directory.provision.action")}
      </Button>
      {(lacksRealEmail || inlineError) && (
        <p className="max-w-prose text-xs text-destructive" role="alert">
          {inlineError ?? t("directory.provision.needsEmail")}
        </p>
      )}
    </div>
  );
}
