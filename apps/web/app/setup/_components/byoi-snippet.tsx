"use client";

import { CheckIcon, ClipboardIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * What an operator sets to wire their own OIDC provider (ADR-0102 §2). Keep in sync with
 * apps/web/auth.ts and the API's boot config, which requires OIDC_JWKS_URI under AUTH_MODE=oidc.
 */
const WEB_SNIPPET = `AUTH_ISSUER=https://auth.example.com
AUTH_CLIENT_ID=your-client-id
AUTH_CLIENT_SECRET=your-client-secret`;

const API_SNIPPET = `AUTH_MODE=oidc
OIDC_ISSUER=https://auth.example.com
OIDC_CLIENT_ID=your-client-id
OIDC_JWKS_URI=https://auth.example.com/.well-known/jwks.json`;

const SNIPPET = `${WEB_SNIPPET}\n\n${API_SNIPPET}`;

function SnippetBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <pre className="overflow-x-auto whitespace-pre rounded bg-background px-3 py-2 font-mono text-xs text-foreground">
        {value}
      </pre>
    </div>
  );
}

export function ByoiSnippet() {
  const t = useTranslations("setup.byoi");
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(SNIPPET).then(() => {
      setCopied(true);
      toast.success(t("copied"));
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">
          {t("instructions")}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={copy}
          aria-label={t("copyLabel")}
        >
          {copied ? (
            <CheckIcon className="text-success" />
          ) : (
            <ClipboardIcon />
          )}
        </Button>
      </div>
      <div className="space-y-2">
        <SnippetBlock label={t("webLabel")} value={WEB_SNIPPET} />
        <SnippetBlock label={t("apiLabel")} value={API_SNIPPET} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("note")}</p>
    </div>
  );
}
