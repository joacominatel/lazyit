"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { PermissionGate } from "@/components/permission-gate";
import { ErrorState } from "@/components/resource-table";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { useWorkflowRun } from "@/lib/api/hooks/use-workflow-runs";
import type { WorkflowRunDetail } from "@/lib/api/endpoints/workflow-runs";
import { ReplayLatestButton } from "../../_components/replay-latest-button";
import { RetryRunButton } from "../../_components/retry-run-button";
import { RunTimeline } from "../../_components/run-timeline";

/**
 * Run-detail page (frontend.md §7b) — the audit/debugging surface for one workflow run, gated on
 * `workflow:read`. Reuses the asset-history timeline grammar via {@link RunTimeline}. The hook polls
 * while the run is non-terminal and stops once it terminates (no SSE yet — short polling is the
 * dependency-free floor).
 */
export default function WorkflowRunDetailPage() {
  const t = useTranslations("workflow");
  const params = useParams<{ id: string; runId: string }>();
  const { id: applicationId, runId } = params;

  const { data: application } = useApplication(applicationId);
  const { data: run, isLoading, isError, error, refetch } =
    useWorkflowRun(runId);

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: t("breadcrumb.applications"), href: "/applications" },
          {
            label: application?.name ?? applicationId,
            href: `/applications/${applicationId}`,
          },
          {
            label: t("breadcrumb.workflows"),
            href: `/applications/${applicationId}/workflows`,
          },
          { label: t("runDetail.title") },
        ]}
      />
    ),
    [t, application?.name, applicationId, runId],
  );

  return (
    <div className="mx-auto max-w-3xl">
      <PermissionGate
        permission="workflow:read"
        title={t("gate.title")}
        description={t("gate.description")}
      >
        <div className="space-y-6">
          <PageHeader
            breadcrumb={breadcrumb}
            title={t("runDetail.title")}
            subtitle={t("runDetail.subtitle")}
          />

          {isLoading ? (
            <DetailSkeleton panels={1} />
          ) : isError || !run ? (
            <ErrorState
              title={t("runDetail.notFoundTitle")}
              description={t("runDetail.notFoundDescription")}
              onRetry={() => refetch()}
              error={error}
            />
          ) : (
            <DetailPanel
              title={t("runDetail.timelineTitle")}
              actions={<RunActions run={run} applicationId={applicationId} />}
            >
              <RunTimeline run={run} />
            </DetailPanel>
          )}
        </div>
      </PermissionGate>
    </div>
  );
}

/**
 * The run-detail action cluster (ADR-0057). For a FAILED run it offers two distinct re-drive paths, both
 * gated `workflow:run` (each control hides itself when the run is not FAILED or the caller lacks the
 * permission): RETRY (resume the SAME run on its pinned version — with an OPTIONAL one-off field override
 * for the failed step, Option 2) and REPLAY WITH LATEST (a fresh run on the current version, Option 3).
 * The failed step's already-mapped field NAMES (redacted projection, issue #347 — never their values)
 * seed the override inspector so the operator sees the context the pinned mapping sent.
 */
function RunActions({
  run,
  applicationId,
}: {
  run: WorkflowRunDetail;
  applicationId: string;
}) {
  const failedStep = findFailedStep(run);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <RetryRunButton
        runId={run.id}
        status={run.status}
        failedStepKey={failedStep?.stepKey ?? null}
        mappedFields={failedStep?.mappedFields ?? []}
      />
      <ReplayLatestButton
        runId={run.id}
        status={run.status}
        applicationId={applicationId}
      />
    </div>
  );
}

/**
 * The step a retry resumes from — the LAST recorded FAILED step attempt (the run's terminal failure). The
 * step attempts are ordered; the last FAILED row is the one the resume-from-failed-step retry picks up,
 * and the one whose mapping an override would patch. Returns null when no failed step is recorded.
 */
function findFailedStep(run: WorkflowRunDetail) {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const step = run.steps[i];
    if (step && step.status === "FAILED") {
      return step;
    }
  }
  return null;
}
