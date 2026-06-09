"use client";

import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { PermissionGate } from "@/components/permission-gate";
import { ErrorState } from "@/components/resource-table";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { useWorkflowRun } from "@/lib/api/hooks/use-workflow-runs";
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

  return (
    <div className="mx-auto max-w-3xl">
      <PermissionGate
        permission="workflow:read"
        title={t("gate.title")}
        description={t("gate.description")}
      >
        <div className="space-y-6">
          <PageHeader
            breadcrumb={
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
            }
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
              actions={<RetryRunButton runId={run.id} status={run.status} />}
            >
              <RunTimeline run={run} />
            </DetailPanel>
          )}
        </div>
      </PermissionGate>
    </div>
  );
}
