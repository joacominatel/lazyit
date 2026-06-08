"use client";

import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { PermissionGate } from "@/components/permission-gate";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { WorkflowBuilder } from "../_components/builder/workflow-builder";

/**
 * New-workflow builder route (frontend.md §3b) — authors a fresh workflow definition for an application.
 * Gated on `workflow:manage` (the create/configure verb). A full-page route, not a dialog, because the
 * builder is multi-section and iterated.
 */
export default function NewWorkflowPage() {
  const t = useTranslations("workflow");
  const params = useParams<{ id: string }>();
  const applicationId = params.id;
  const { data: application } = useApplication(applicationId);

  return (
    <PermissionGate
      permission="workflow:manage"
      title={t("gate.manageTitle")}
      description={t("gate.manageDescription")}
    >
      <WorkflowBuilder
        applicationId={applicationId}
        applicationName={application?.name ?? applicationId}
      />
    </PermissionGate>
  );
}
