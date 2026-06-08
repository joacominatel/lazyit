"use client";

import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { DetailSkeleton } from "@/components/detail-panel";
import { PermissionGate } from "@/components/permission-gate";
import { ErrorState } from "@/components/resource-table";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { useWorkflow } from "@/lib/api/hooks/use-workflows";
import { WorkflowBuilder } from "../../_components/builder/workflow-builder";

/**
 * Edit-workflow builder route (frontend.md §3b) — re-opens an existing workflow's latest version graph
 * for editing. Gated on `workflow:manage`. The trigger is immutable in edit mode (the builder enforces
 * it); saving authors a NEW immutable version.
 */
export default function EditWorkflowPage() {
  const t = useTranslations("workflow");
  const params = useParams<{ id: string; workflowId: string }>();
  const { id: applicationId, workflowId } = params;
  const { data: application } = useApplication(applicationId);
  const { data: workflow, isLoading, isError, error, refetch } =
    useWorkflow(workflowId);

  return (
    <PermissionGate
      permission="workflow:manage"
      title={t("gate.manageTitle")}
      description={t("gate.manageDescription")}
    >
      {isLoading ? (
        <div className="mx-auto max-w-3xl">
          <DetailSkeleton panels={2} />
        </div>
      ) : isError || !workflow ? (
        <div className="mx-auto max-w-3xl">
          <ErrorState
            title={t("builder.notFoundTitle")}
            description={t("builder.notFoundDescription")}
            onRetry={() => refetch()}
            error={error}
          />
        </div>
      ) : (
        <WorkflowBuilder
          applicationId={applicationId}
          applicationName={application?.name ?? applicationId}
          workflow={workflow}
        />
      )}
    </PermissionGate>
  );
}
