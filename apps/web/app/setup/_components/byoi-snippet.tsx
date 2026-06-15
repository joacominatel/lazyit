"use client";

import { CheckIcon, ClipboardIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * The three env vars an operator sets to wire their own OIDC provider (BYOI — ADR-0037/0039 §7a).
 * Shown when "Bring your own OIDC" is selected in step 1, with a copy button. These are the same
 * three vars apps/web/auth.ts reads — keep them in sync if that contract changes.
 */
const SNIPPET = `AUTH_ISSUER=https://auth.example.com
AUTH_CLIENT_ID=your-client-id
AUTH_CLIENT_SECRET=your-client-secret`;

export function ByoiSnippet() {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(SNIPPET).then(() => {
      setCopied(true);
      toast.success("Copied");
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">
          Set these on the web app, then restart it:
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={copy}
          aria-label="Copy environment variables"
        >
          {copied ? (
            <CheckIcon className="text-success" />
          ) : (
            <ClipboardIcon />
          )}
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre rounded bg-background px-3 py-2 font-mono text-xs text-foreground">
        {SNIPPET}
      </pre>
      <p className="mt-2 text-xs text-muted-foreground">
        lazyit discovers the rest from your provider. User and role management
        stays local — your IdP owns sign-in only.
      </p>
    </div>
  );
}
