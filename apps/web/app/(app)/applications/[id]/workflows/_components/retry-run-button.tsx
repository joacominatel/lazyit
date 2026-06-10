"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { WorkflowRunStatus } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useRetryWorkflowRun } from "@/lib/api/hooks/use-workflow-runs";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";

/**
 * The "Reintentar" action (issue #308) — re-drives a terminal FAILED run from the step that failed
 * onward (resume-from-failed-step, NOT a full re-run, so already-SUCCEEDED steps never re-execute). It
 * renders ONLY for a FAILED run and ONLY for a `workflow:run` holder (the API guard is the real gate;
 * this just hides a control the user could not use). On success the run flips back to RUNNING and both
 * the run detail and the recent-runs list invalidate (the hook), so the timeline polls the resumed run
 * live. A 409 (no longer FAILED) / 422 (no resolvable failed step) / broker hiccup surfaces via
 * `notifyError` with the request id.
 */
export function RetryRunButton({
  runId,
  status,
  size = "sm",
  variant = "outline",
  className,
}: {
  runId: string;
  status: WorkflowRunStatus;
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "ghost" | "default";
  className?: string;
}) {
  const t = useTranslations("workflow");
  const canRetry = useCan("workflow:run");
  const retry = useRetryWorkflowRun();

  // Only a terminal FAILED run is retryable (a COMPENSATED run already rolled its effects back — it is
  // re-granted, not retried; the backend enforces this too). Hide the control otherwise.
  if (status !== "FAILED" || !canRetry) {
    return null;
  }

  function onRetry(event: React.MouseEvent) {
    // Stop the click bubbling to an enclosing row-link (the recent-runs row is itself a Link).
    event.preventDefault();
    event.stopPropagation();
    retry.mutate(runId, {
      onSuccess: () => toast.success(t("runRetry.toastSuccess")),
      onError: (err) => notifyError(err, t("runRetry.toastError")),
    });
  }

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      disabled={retry.isPending}
      onClick={onRetry}
      aria-label={t("runRetry.action")}
    >
      <ArrowPathIcon className={retry.isPending ? "animate-spin" : undefined} />
      {t("runRetry.action")}
    </Button>
  );
}
