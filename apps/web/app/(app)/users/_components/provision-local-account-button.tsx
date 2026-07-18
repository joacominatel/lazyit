"use client";

import {
  ArrowPathIcon,
  CheckIcon,
  ClipboardIcon,
  ExclamationTriangleIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";
import type { User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { useProvisionLocalUserAccount } from "@/lib/api/hooks/use-user-mutations";
import { notifyError } from "@/lib/api/notify-error";

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
 * it INLINE with copy-to-clipboard and require an explicit acknowledgement to dismiss (mirroring the
 * one-time service-account secret reveal). It lives only in this component's state — never the cache.
 */

/**
 * Legacy clipboard copy for insecure (plain-HTTP LAN) contexts where `navigator.clipboard` is undefined —
 * local auth mode is the LAN posture, so this fallback matters for a credential that must be capturable.
 * Selects a throwaway off-screen field and runs `execCommand('copy')`. Returns whether it succeeded.
 */
function legacyCopy(text: string): boolean {
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.top = "0";
    field.style.left = "0";
    field.style.opacity = "0";
    field.style.pointerEvents = "none";
    document.body.appendChild(field);
    field.focus();
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

export function ProvisionLocalAccountButton({ user }: { user: User }) {
  const t = useTranslations("users");
  const tc = useTranslations("common");
  const provision = useProvisionLocalUserAccount();
  // The minted temp password, shown ONCE. Lives only here — deliberately never the TanStack cache.
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  function handleClick() {
    provision.mutate(user.id, {
      onSuccess: (result) => {
        setTempPassword(result.temporaryPassword);
        setAcknowledged(false);
        setCopied(false);
        toast.success(
          t("directory.provisionLocal.success", {
            name: `${user.firstName} ${user.lastName}`,
          }),
        );
      },
      onError: (error) => notifyError(error, t("directory.provisionLocal.error")),
    });
  }

  // Copy must never be a silent no-op: the async Clipboard API only exists on HTTPS / localhost, so on a
  // plain-HTTP LAN install fall back to the legacy path, and if even that fails tell the operator to
  // select + copy the password manually rather than leaving them with a lost credential.
  async function copy() {
    if (!tempPassword) return;
    const markCopied = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(tempPassword);
        markCopied();
        return;
      } catch {
        // Permission denied / blocked — fall through to the legacy path.
      }
    }
    if (legacyCopy(tempPassword)) {
      markCopied();
      return;
    }
    toast.error(t("directory.provisionLocal.reveal.copyUnavailable"));
  }

  if (tempPassword) {
    return (
      <div className="w-full space-y-4 sm:max-w-md">
        <p className="text-sm">
          {t.rich("directory.provisionLocal.reveal.message", {
            name: `${user.firstName} ${user.lastName}`,
            b: (chunks) => (
              <span className="font-medium text-foreground">{chunks}</span>
            ),
          })}
        </p>

        <Callout
          tone="warning"
          icon={<ExclamationTriangleIcon />}
          className="rounded-lg text-sm"
        >
          {t("directory.provisionLocal.reveal.warning")}
        </Callout>

        <div className="space-y-2 rounded-lg border bg-muted/50 p-2">
          {/* Full-width + select-all so a single click grabs the whole password — manual capture always
              works even when the clipboard API is unavailable over plain HTTP. */}
          <code className="block w-full overflow-x-auto font-mono text-sm break-all whitespace-pre-wrap select-all">
            {tempPassword}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copy}
            aria-label={t("directory.provisionLocal.reveal.copyAria")}
          >
            {copied ? <CheckIcon /> : <ClipboardIcon />}
            {copied ? tc("copied") : tc("copy")}
          </Button>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 size-4 rounded border-input accent-primary"
          />
          <span>{t("directory.provisionLocal.reveal.acknowledge")}</span>
        </label>

        <div className="flex justify-end">
          <Button
            type="button"
            onClick={() => setTempPassword(null)}
            disabled={!acknowledged}
          >
            {t("directory.provisionLocal.reveal.done")}
          </Button>
        </div>
      </div>
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
