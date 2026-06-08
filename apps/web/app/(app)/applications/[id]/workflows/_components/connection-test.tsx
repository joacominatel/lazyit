"use client";

import { ArrowPathIcon, SignalIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type { TestConnectionResult } from "@/lib/api/endpoints/workflow-connections";
import { useTestWorkflowConnection } from "@/lib/api/hooks/use-workflow-connections";
import { notifyError } from "@/lib/api/notify-error";

/**
 * C3 — the "Test connection" affordance (frontend.md §4c). A bounded, READ-ONLY probe of a connection's
 * connectivity + credential: it NEVER provisions and never echoes the secret. Renders the probe outcome
 * inline — a success/failure pill, the API's (already-safe) message, the HTTP status when the probe made
 * an HTTP call, and the request id for correlation (ADR-0031). The whole control is mounted only for a
 * `workflow:manage` holder (gated by the parent card); every value is rendered as escaped text (SEC-A5).
 */
export function ConnectionTest({ connectionId }: { connectionId: string }) {
  const t = useTranslations("workflow");
  const testConnection = useTestWorkflowConnection();
  const [result, setResult] = useState<TestConnectionResult | null>(null);

  function run() {
    setResult(null);
    testConnection.mutate(connectionId, {
      onSuccess: (outcome) => setResult(outcome),
      onError: (error) => notifyError(error, t("connectionTest.error")),
    });
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={run}
          disabled={testConnection.isPending}
        >
          {testConnection.isPending ? (
            <ArrowPathIcon className="animate-spin" />
          ) : (
            <SignalIcon />
          )}
          {t("connectionTest.button")}
        </Button>
        <p className="text-xs text-muted-foreground">
          {t("connectionTest.hint")}
        </p>
      </div>

      {result ? (
        <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={result.ok ? "success" : "danger"}>
              {t(result.ok ? "connectionTest.ok" : "connectionTest.failed")}
            </StatusBadge>
            {result.status != null ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("connectionTest.httpStatus", { status: result.status })}
              </span>
            ) : null}
          </div>
          {/* SEC-A5: the API message is rendered as escaped text only. */}
          <p className="text-sm break-words">{result.message}</p>
          <RequestIdNote requestId={result.requestId} />
        </div>
      ) : null}
    </div>
  );
}
