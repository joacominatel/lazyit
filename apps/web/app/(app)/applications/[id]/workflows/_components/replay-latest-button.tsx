"use client";

import { ArrowUturnUpIcon } from "@heroicons/react/24/outline";
import type { WorkflowRunStatus } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { useReplayLatestWorkflowRun } from "@/lib/api/hooks/use-workflow-runs";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * The "Replay with latest" action (ADR-0057 Option 3) — clone-to-new-run from the LATEST workflow version.
 * It renders ONLY for a FAILED run and ONLY for a `workflow:run` holder (the API guard is the real gate).
 * Unlike Retry (which resumes the SAME run on its PINNED version and so cannot see an edited mapping), this
 * starts a FRESH run on the current version for the same grant — the path that adopts «I fixed the flow,
 * now make it go through». The source FAILED run stays immutable.
 *
 * A confirm step spells out that it starts a NEW run on the latest version. On success it navigates to the
 * new run (the response's `runId`) and toasts. Errors are surfaced HONESTLY:
 *  - 422 — the FAIL-CLOSED double-provision guard refused: the run already provisioned a non-idempotent
 *    create, so a clean re-fire would double-provision. The operator must RE-GRANT, not replay.
 *  - 409 — the source run is no longer FAILED (already re-driven elsewhere).
 *  - anything else — a generic failure with the request id (via `notifyError`).
 */
export function ReplayLatestButton({
  runId,
  status,
  applicationId,
  size = "sm",
  variant = "outline",
  className,
}: {
  runId: string;
  status: WorkflowRunStatus;
  applicationId: string;
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "ghost" | "default";
  className?: string;
}) {
  const t = useTranslations("workflow");
  const router = useRouter();
  const canRun = useCan("workflow:run");
  const replay = useReplayLatestWorkflowRun();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Only a terminal FAILED run can be replayed (a COMPENSATED run already rolled back — re-grant it). Hide
  // the control otherwise; the backend enforces the FAILED precondition too (409 if it changed underfoot).
  if (status !== "FAILED" || !canRun) {
    return null;
  }

  async function onConfirm() {
    try {
      const result = await replay.mutateAsync(runId);
      toast.success(t("runReplay.toastSuccess"));
      // Navigate to the NEW run on the latest version (the response's runId).
      router.push(
        `/applications/${applicationId}/workflows/runs/${result.runId}`,
      );
    } catch (err) {
      // Honest, specific copy for the two domain refusals; generic otherwise (with the request id).
      if (err instanceof ApiError && err.status === 422) {
        notifyError(err, t("runReplay.toastGuardRefused"));
      } else if (err instanceof ApiError && err.status === 409) {
        notifyError(err, t("runReplay.toastNotFailed"));
      } else {
        notifyError(err, t("runReplay.toastError"));
      }
      // Re-throw so the ConfirmDialog keeps itself open on failure (the operator can read the toast and
      // decide to re-grant rather than silently dismissing).
      throw err;
    }
  }

  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        className={className}
        disabled={replay.isPending}
        onClick={(event) => {
          // Stop the click bubbling to an enclosing row-link, mirroring RetryRunButton.
          event.preventDefault();
          event.stopPropagation();
          setConfirmOpen(true);
        }}
        aria-label={t("runReplay.action")}
      >
        <ArrowUturnUpIcon
          className={replay.isPending ? "animate-spin" : undefined}
        />
        {t("runReplay.action")}
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("runReplay.confirmTitle")}
        description={t("runReplay.confirmDescription")}
        confirmLabel={t("runReplay.confirmAction")}
        onConfirm={onConfirm}
      />
    </>
  );
}
