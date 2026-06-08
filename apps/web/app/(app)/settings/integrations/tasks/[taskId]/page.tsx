"use client";

import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { PermissionGate } from "@/components/permission-gate";
import { ErrorState } from "@/components/resource-table";
import { useWorkflowTask } from "@/lib/api/hooks/use-workflow-tasks";
import { TaskAction } from "../../_components/task-action";

/**
 * The single manual-task page (frontend.md §6b) — the action form for resolving one task. Gated on
 * `workflow:read` to view; the Submit/Skip/Fail actions gate on `workflow:task` (enforced server-side).
 */
export default function WorkflowTaskDetailPage() {
  const t = useTranslations("workflow");
  const params = useParams<{ taskId: string }>();
  const { data: task, isLoading, isError, error, refetch } = useWorkflowTask(
    params.taskId,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PermissionGate
        permission="workflow:read"
        title={t("gate.title")}
        description={t("gate.description")}
      >
        <PageHeader
          breadcrumb={
            <Breadcrumb
              items={[
                { label: t("breadcrumb.settings"), href: "/settings" },
                {
                  label: t("inbox.title"),
                  href: "/settings/integrations/tasks",
                },
                { label: t("taskAction.title") },
              ]}
            />
          }
          title={t("taskAction.title")}
          subtitle={t("taskAction.subtitle")}
        />

        {isLoading ? (
          <DetailSkeleton panels={2} />
        ) : isError || !task ? (
          <ErrorState
            title={t("taskAction.notFoundTitle")}
            description={t("taskAction.notFoundDescription")}
            onRetry={() => refetch()}
            error={error}
          />
        ) : (
          <TaskAction task={task} />
        )}
      </PermissionGate>
    </div>
  );
}
