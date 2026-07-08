"use client";

import { ArrowPathIcon, KeyIcon } from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfigStatus } from "@/lib/api/hooks/use-config-status";
import { useProvisionUserAccount } from "@/lib/api/hooks/use-user-mutations";
import { classifyProvisionError } from "./provision-account-error";

/**
 * The manual "Create OIDC account" promotion (ADR-0069 REDESIGN §0 #3) — the explicit counterpart to the
 * auto-claim-by-verified-email login (ADR-0038). For a directory person (no login, created by the bulk
 * import) an ADMIN can provision their account in the identity provider right now. Rendered ONLY for a
 * directory person; the caller already gates on `user:manage` (the same coarse capability behind every
 * other admin user action), so this component doesn't re-check the permission.
 *
 * Provisioning only works when the active IdP MANAGES users (bundled Zitadel). In `AUTH_MODE=local` and
 * BYOI / generic-OIDC there is no write-back, so the promotion ALWAYS 400s — offering it there is a lie
 * (issue #1048). We read `canProvisionAccounts` from `GET /config/status` and, when it is explicitly
 * false, render a short "not available in this mode" note instead of an impossible button.
 *
 * When provisioning IS available (Zitadel requires a real email):
 *   - When the person has no real email — missing, or the synthesized `…@directory.local` placeholder the
 *     import mints when a row has no email — we pre-disable the button and show the "needs an email" hint
 *     inline (no point firing a request we know will 400).
 *   - The backend is still the source of truth: a 400 is surfaced inline (`role=alert`) using the SERVER'S
 *     OWN message (never a silent failure, and never the misleading "needs an email" blanket text — the
 *     backend 400s for four distinct reasons, #1048), so the operator sees the real cause.
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
  const configStatus = useConfigStatus();
  // The inline 400 message (server says this person can't be promoted as-is — the real cause, #1048).
  const [inlineError, setInlineError] = useState<string | null>(null);

  // Whether the active IdP can provision accounts at all (bundled Zitadel only, #1048). Only hide the
  // action when the server EXPLICITLY says it can't — while the status is still loading we optimistically
  // show the button (a Zitadel instance never flashes the note; a LOCAL one settles into it a beat later).
  const canProvision = configStatus.data?.canProvisionAccounts !== false;

  // No real email → no Zitadel account. Pre-disable + hint (the backend still 400s as the authority).
  const lacksRealEmail =
    !user.email || user.email.endsWith(DIRECTORY_PLACEHOLDER_EMAIL_DOMAIN);

  // The IdP can't provision accounts (LOCAL / BYOI) — don't offer an action that always fails; explain why.
  if (!canProvision) {
    return (
      <p className="max-w-prose text-xs text-muted-foreground" role="note">
        {t("directory.provision.unsupported")}
      </p>
    );
  }

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
        // A 400 means this person can't be promoted as mapped — the backend 400s for four distinct reasons
        // (not a directory person / already linked / placeholder email / IdP can't provision, #1048), so we
        // surface the SERVER'S OWN message inline instead of a blanket "needs an email" that often lies.
        // Fall back to the generic hint only if the server sent no message. Everything else → error toast.
        const surface = classifyProvisionError(error);
        if (surface.mode === "inline") {
          setInlineError(surface.message ?? t("directory.provision.needsEmail"));
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
