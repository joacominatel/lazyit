"use client";

import type { AiRunError } from "@lazyit/shared";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { RequestIdNote } from "@/components/request-id-note";
import { runErrorKind } from "@/lib/ai/error-kinds";

/**
 * A run error or a client notice (frontend.md §5.6): the localized message for the code — never the raw
 * server text, which can carry provider detail — and the recovery action it allows.
 */
export function AiRunNotice({
  error,
  onRetry,
  onNewChat,
  onReconnect,
  onDismiss,
}: {
  error: AiRunError;
  onRetry?: () => void;
  onNewChat?: () => void;
  onReconnect?: () => void;
  onDismiss?: () => void;
}) {
  const t = useTranslations("ai.errors");
  const kind = runErrorKind(error.code);
  if (error.code === "CANCELLED") {
    return <p className="text-xs text-muted-foreground">{t("run.CANCELLED")}</p>;
  }
  return (
    <div role="alert" className="rounded-sm border border-border bg-muted/50 px-3 py-2 text-xs">
      <p className="flex items-start gap-1.5">
        <ExclamationTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning-text" aria-hidden />
        <span>
          {t(`run.${kind.key}`)}
          {typeof error.retryAfterSec === "number" && error.retryAfterSec > 0 && (
            <> {t("retryIn", { seconds: error.retryAfterSec })}</>
          )}
        </span>
      </p>
      <RequestIdNote requestId={error.requestId} className="mt-1" />
      <div className="mt-2 flex flex-wrap gap-2">
        {error.code === "NETWORK" && onReconnect && (
          <Button type="button" size="xs" variant="outline" onClick={onReconnect}>
            {t("reconnect")}
          </Button>
        )}
        {kind.action === "retry" && error.code !== "NETWORK" && onRetry && (
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            {t("retry")}
          </Button>
        )}
        {kind.action === "newChat" && onNewChat && (
          <Button type="button" size="xs" variant="outline" onClick={onNewChat}>
            {t("newChat")}
          </Button>
        )}
        {onDismiss && (
          <Button type="button" size="xs" variant="ghost" onClick={onDismiss}>
            {t("dismiss")}
          </Button>
        )}
      </div>
    </div>
  );
}
