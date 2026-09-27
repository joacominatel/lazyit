"use client";

import {
  CheckIcon,
  ClipboardIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";

/**
 * The ONE shown-once presentation for a temporary password an admin must hand off. Both local-mode
 * paths that mint one share it: onboarding a directory person
 * ({@link ProvisionLocalAccountButton}, ADR-0086 §5 / #1072) and an admin password reset
 * ({@link LocalPasswordResetDialog}, #1268). The API returns the plaintext exactly ONCE and it is never
 * refetchable, so the reveal is deliberately hostile to being dismissed by accident: a warning callout,
 * a select-all code block, copy-to-clipboard, and an explicit acknowledgement before the caller's
 * `onDone` fires.
 *
 * The password lives only in the caller's component state — never the TanStack cache — and this
 * component never persists it anywhere either. The lead-in sentence differs per path, so it comes in as
 * `message`; everything below it is identical by design and lives here.
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

export function TemporaryPasswordReveal({
  password,
  message,
  onDone,
}: {
  /** The plaintext, shown once. Never store or log it. */
  password: string;
  /** The path-specific lead-in (who this is for, what happens at first sign-in). */
  message: ReactNode;
  /** Fired once the admin confirms they captured the password. */
  onDone: () => void;
}) {
  const t = useTranslations("users.temporaryPasswordReveal");
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  // Copy must never be a silent no-op: the async Clipboard API only exists on HTTPS / localhost, so on a
  // plain-HTTP LAN install fall back to the legacy path, and if even that fails tell the operator to
  // select + copy the password manually rather than leaving them with a lost credential.
  async function copy() {
    const markCopied = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(password);
        markCopied();
        return;
      } catch {
        // Permission denied / blocked — fall through to the legacy path.
      }
    }
    if (legacyCopy(password)) {
      markCopied();
      return;
    }
    toast.error(t("copyUnavailable"));
  }

  return (
    <div className="w-full space-y-4 sm:max-w-md">
      <p className="text-sm">{message}</p>

      <Callout
        tone="warning"
        icon={<ExclamationTriangleIcon />}
        className="rounded-lg text-sm"
      >
        {t("warning")}
      </Callout>

      <div className="space-y-2 rounded-lg border bg-muted/50 p-2">
        {/* Full-width + select-all so a single click grabs the whole password — manual capture always
            works even when the clipboard API is unavailable over plain HTTP. */}
        <code className="block w-full overflow-x-auto font-mono text-sm break-all whitespace-pre-wrap select-all">
          {password}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          aria-label={t("copyAria")}
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
        <span>{t("acknowledge")}</span>
      </label>

      <div className="flex justify-end">
        <Button type="button" onClick={onDone} disabled={!acknowledged}>
          {t("done")}
        </Button>
      </div>
    </div>
  );
}
