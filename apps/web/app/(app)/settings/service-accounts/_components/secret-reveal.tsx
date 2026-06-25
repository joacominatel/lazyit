"use client";

import {
  ArrowDownTrayIcon,
  CheckIcon,
  ClipboardIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import type { Permission } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { TestItPanel } from "./test-it-panel";

interface SecretRevealProps {
  /** The service account's display name (for the heading). */
  name: string;
  /** The full cleartext token (`lzit_sa_<id>_<secret>`), shown EXACTLY ONCE. */
  token: string;
  /** Acknowledged "I've saved it" → dismiss the panel. */
  onAcknowledge: () => void;
  /** Heading verb — create ("created") vs rotate ("rotated"). */
  action: "created" | "rotated";
  /**
   * The account's permissions — when provided, a compact permission-aware "how to test it works"
   * block ({@link TestItPanel}) is appended so the operator can verify the fresh token immediately
   * (issue #197). The snippet uses a `<…>` placeholder, NEVER the real `token` above.
   */
  permissions?: readonly Permission[];
  /**
   * Reports whether the reveal must NOT be dismissed yet (issue #813). It is `true` while the token is
   * shown and unacknowledged, `false` once the operator acknowledges and on unmount. The owning dialog
   * uses it to suppress Escape / overlay-click / the close button so the once-only credential cannot be
   * destroyed by an accidental dismissal.
   */
  onLockedChange?: (locked: boolean) => void;
}

/** Slugify a display name into a filesystem-safe download stem (ASCII, lowercase, dashes). */
function downloadStem(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "service-account";
}

/**
 * Legacy clipboard copy for insecure (plain-HTTP LAN) contexts where `navigator.clipboard` is
 * `undefined`. Selects a throwaway off-screen field and runs the deprecated `execCommand('copy')`,
 * which still works over HTTP in current browsers. Returns whether the copy succeeded.
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
  permissions,
  onLockedChange,
}: SecretRevealProps) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  // Lock the owning dialog against accidental dismissal until the operator acknowledges (issue #813).
  // Releases the lock on acknowledge and on unmount so a re-opened dialog dismisses normally again.
  useEffect(() => {
    onLockedChange?.(!acknowledged);
    return () => onLockedChange?.(false);
  }, [acknowledged, onLockedChange]);

  const markCopied = () => {
    setCopied(true);
    toast.success(t("serviceAccounts.toast.tokenCopied"));
    setTimeout(() => setCopied(false), 1500);
  };

  // Copy must never be a silent no-op (issue #813): the async Clipboard API only exists on HTTPS /
  // localhost, so on a plain-HTTP LAN install fall back to the legacy path, and if even that fails
  // tell the operator explicitly to use Download instead of leaving them with a lost credential.
  const copy = async () => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(token);
        markCopied();
        return;
      } catch {
        // Permission denied / blocked — fall through to the legacy path.
      }
    }
    if (legacyCopy(token)) {
      markCopied();
      return;
    }
    toast.error(t("serviceAccounts.toast.copyUnavailable"));
  };

  // Download the token as a .txt so capture never depends on the clipboard API (issue #813).
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([token], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${downloadStem(name)}-token.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success(t("serviceAccounts.toast.tokenDownloaded"));
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

      <Callout
        tone="warning"
        icon={<ExclamationTriangleIcon />}
        className="rounded-lg text-sm"
      >
        {t("serviceAccounts.secretReveal.warning")}
      </Callout>

      <div className="space-y-2 rounded-lg border bg-muted/50 p-2">
        {/* Full-width + `select-all` so a single click selects the whole token — manual capture
            always works even when the clipboard API is unavailable (issue #813). */}
        <code className="block w-full overflow-x-auto font-mono text-xs break-all whitespace-pre-wrap select-all">
          {token}
        </code>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copy}
            aria-label={t("serviceAccounts.secretReveal.copyTokenAria")}
          >
            {copied ? <CheckIcon /> : <ClipboardIcon />}
            {copied ? tc("copied") : tc("copy")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={download}
            aria-label={t("serviceAccounts.secretReveal.downloadTokenAria")}
          >
            <ArrowDownTrayIcon />
            {tc("download")}
          </Button>
        </div>
      </div>

      {permissions && permissions.length > 0 ? (
        <TestItPanel
          permissions={permissions}
          className="rounded-lg border bg-muted/20 p-3"
        />
      ) : null}

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
