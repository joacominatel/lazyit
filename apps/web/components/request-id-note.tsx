"use client";

import { CheckIcon, ClipboardIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Small inline display of an API request id (the server's `X-Request-Id` — ADR-0031) with a
 * copy-to-clipboard button. Shown in failure surfaces (the error boundary, list error states) so a
 * user can quote it when reporting. Renders nothing when there is no id (e.g. a network error that
 * never reached the API, or the header wasn't exposed).
 */
export function RequestIdNote({
  requestId,
  className,
}: {
  requestId?: string;
  className?: string;
}) {
  const t = useTranslations("shared");
  const [copied, setCopied] = useState(false);

  if (!requestId) return null;

  const copy = () => {
    void navigator.clipboard?.writeText(requestId).then(() => {
      setCopied(true);
      toast.success(t("errors.requestIdCopied"));
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span>{t("errors.requestId")}</span>
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
        {requestId}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={copy}
        aria-label={t("errors.copyRequestId")}
      >
        {copied ? <CheckIcon /> : <ClipboardIcon />}
      </Button>
    </div>
  );
}
