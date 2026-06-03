"use client";

import {
  CheckIcon,
  ClipboardIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
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
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(token).then(() => {
      setCopied(true);
      toast.success("Token copied");
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm">
          <span className="font-medium text-foreground">{name}</span> was{" "}
          {action}. Here is its token.
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
        <ExclamationTriangleIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          Copy it now — you won&apos;t see it again. We only store a hash of the
          token, so it can never be shown or recovered later. If you lose it,
          rotate the account to mint a new one.
        </span>
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
            aria-label="Copy token"
          >
            {copied ? <CheckIcon /> : <ClipboardIcon />}
            {copied ? "Copied" : "Copy"}
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
        <span>I&apos;ve saved this token in a secure place.</span>
      </label>

      <div className="flex justify-end">
        <Button type="button" onClick={onAcknowledge} disabled={!acknowledged}>
          Done
        </Button>
      </div>
    </div>
  );
}
