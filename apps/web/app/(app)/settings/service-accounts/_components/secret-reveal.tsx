"use client";

import {
  CheckIcon,
  ClipboardIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface SecretRevealProps {
  /** The service account's display name (for the heading). */
  name: string;
  /** The full cleartext token (`lzit_sa_<id>_<secret>`), shown EXACTLY ONCE. */
  token: string;
  /** Acknowledged "I've saved it" → dismiss the panel. */
  onAcknowledge: () => void;
  /** Heading verb — create ("created") vs rotate ("rotated"). */
  action: "created" | "rotated";
}

/**
 * The one-time secret reveal (ADR-0048). The cleartext token (`lzit_sa_<id>_<secret>`) is the ONLY
 * place the secret ever appears on the wire; the server stores only its SHA-256 hash. It is shown here
 * exactly once, on create / rotate, and is NEVER refetchable — so the panel:
 *   - displays the full token with copy-to-clipboard,
 *   - warns loudly that it will not be shown again,
 *   - requires an explicit "I've saved it" acknowledgement to dismiss (no accidental close losing it).
 *
 * The token lives only in this component's render (passed from the mutation result) and the dialog's
 * local state — it is deliberately never written to the TanStack cache. Closing the dialog drops it.
 */
export function SecretReveal({
  name,
  token,
  onAcknowledge,
  action,
}: SecretRevealProps) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(token).then(() => {
      setCopied(true);
      toast.success(t("serviceAccounts.toast.tokenCopied"));
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const messageKey =
    action === "created"
      ? "serviceAccounts.secretReveal.createdMessage"
      : "serviceAccounts.secretReveal.rotatedMessage";

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm">
          {t.rich(messageKey, {
            name,
            b: (chunks) => (
              <span className="font-medium text-foreground">{chunks}</span>
            ),
          })}
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
        <ExclamationTriangleIcon className="mt-0.5 size-4 shrink-0" />
        <span>{t("serviceAccounts.secretReveal.warning")}</span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-lg border bg-muted/50 p-2">
          <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs break-all whitespace-pre-wrap">
            {token}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copy}
            className="shrink-0"
            aria-label={t("serviceAccounts.secretReveal.copyTokenAria")}
          >
            {copied ? <CheckIcon /> : <ClipboardIcon />}
            {copied ? tc("copied") : tc("copy")}
          </Button>
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5 size-4 rounded border-input accent-primary"
        />
        <span>{t("serviceAccounts.secretReveal.acknowledge")}</span>
      </label>

      <div className="flex justify-end">
        <Button type="button" onClick={onAcknowledge} disabled={!acknowledged}>
          {t("serviceAccounts.secretReveal.done")}
        </Button>
      </div>
    </div>
  );
}
