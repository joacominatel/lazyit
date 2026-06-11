"use client";

import {
  AdjustmentsHorizontalIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";
import type { WorkflowRunStatus } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useRetryWorkflowRun } from "@/lib/api/hooks/use-workflow-runs";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { RetryOverrideDialog } from "./retry-override-dialog";

/**
 * The "Reintentar" action (issue #308) — re-drives a terminal FAILED run from the step that failed
 * onward (resume-from-failed-step, NOT a full re-run, so already-SUCCEEDED steps never re-execute). It
 * renders ONLY for a FAILED run and ONLY for a `workflow:run` holder (the API guard is the real gate;
 * this just hides a control the user could not use). On success the run flips back to RUNNING and both
 * the run detail and the recent-runs list invalidate (the hook), so the timeline polls the resumed run
 * live. A 409 (no longer FAILED) / 422 (no resolvable failed step) / broker hiccup surfaces via
 * `notifyError` with the request id.
 *
 * The plain Retry stays a ONE-CLICK default (no dialog). When the caller supplies the failed step's
 * `mappedFields` (the run-detail surface), a secondary "with overrides…" affordance opens the
 * {@link RetryOverrideDialog} (ADR-0057 Option 2) — a request-scoped, never-persisted field override for
 * the NEXT attempt only. The dialog is never forced; the recent-runs rows (which lack step detail) render
 * only the one-click button.
 */
export function RetryRunButton({
  runId,
  status,
  failedStepKey,
  mappedFields,
  size = "sm",
  variant = "outline",
  className,
}: {
  runId: string;
  status: WorkflowRunStatus;
  /** The failed step's key (run-detail only) — enables the override inspector when provided. */
  failedStepKey?: string | null;
  /** The failed step's already-mapped field NAMES (redacted; never values). Enables the inspector. */
  mappedFields?: readonly string[];
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "ghost" | "default";
  className?: string;
}) {
  const t = useTranslations("workflow");
  const canRetry = useCan("workflow:run");
  const retry = useRetryWorkflowRun();
  const [overrideOpen, setOverrideOpen] = useState(false);

  // The override inspector is offered only when the caller passed the failed-step context (the run-detail
  // page). Recent-runs rows omit it and keep the plain one-click retry.
  const canOverride = mappedFields !== undefined;

  // Only a terminal FAILED run is retryable (a COMPENSATED run already rolled its effects back — it is
  // re-granted, not retried; the backend enforces this too). Hide the control otherwise.
  if (status !== "FAILED" || !canRetry) {
    return null;
  }

  function onRetry(event: React.MouseEvent) {
    // Stop the click bubbling to an enclosing row-link (the recent-runs row is itself a Link).
    event.preventDefault();
    event.stopPropagation();
    retry.mutate(
      { id: runId },
      {
        onSuccess: () => toast.success(t("runRetry.toastSuccess")),
        onError: (err) => notifyError(err, t("runRetry.toastError")),
      },
    );
  }

  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        className={className}
        disabled={retry.isPending}
        onClick={onRetry}
        aria-label={t("runRetry.action")}
      >
        <ArrowPathIcon
          className={retry.isPending ? "animate-spin" : undefined}
        />
        {t("runRetry.action")}
      </Button>

      {canOverride ? (
        <>
          <Button
            type="button"
            size={size}
            variant="ghost"
            disabled={retry.isPending}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOverrideOpen(true);
            }}
            aria-label={t("runRetry.overrideAction")}
          >
            <AdjustmentsHorizontalIcon />
            {t("runRetry.overrideAction")}
          </Button>
          <RetryOverrideDialog
            open={overrideOpen}
            onOpenChange={setOverrideOpen}
            runId={runId}
            failedStepKey={failedStepKey ?? null}
            mappedFields={mappedFields ?? []}
          />
        </>
      ) : null}
    </>
  );
}
