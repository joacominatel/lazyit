"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { PermissionGate } from "@/components/permission-gate";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { ConnectionCard } from "./_components/connection-card";
import { RecentRuns } from "./_components/recent-runs";
import { WorkflowsList } from "./_components/workflows-list";

/**
 * The per-application Workflows tab (frontend.md §2a) — the primary, discovery-first home for the
 * Applications Workflow Engine: the connection card, the workflows list (with the loud "no automation
 * configured" empty state) and recent runs. Gated on `workflow:read` (fails closed). Configuration and
 * credential affordances inside gate further on `workflow:manage` / `workflow:secrets`.
 */
export default function ApplicationWorkflowsPage() {
  const t = useTranslations("workflow");
  const params = useParams<{ id: string }>();
  const applicationId = params.id;
  const { data: application } = useApplication(applicationId);

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: t("breadcrumb.applications"), href: "/applications" },
          {
            label: application?.name ?? applicationId,
            href: `/applications/${applicationId}`,
          },
          { label: t("breadcrumb.workflows") },
        ]}
      />
    ),
    [t, application?.name, applicationId],
  );

  return (
    <div className="mx-auto max-w-4xl">
      <PermissionGate
        permission="workflow:read"
        title={t("gate.title")}
        description={t("gate.description")}
      >
        <div className="space-y-6">
          <PageHeader
            breadcrumb={breadcrumb}
            title={t("tab.title")}
            subtitle={t("tab.subtitle")}
          />

          <ConnectionCard applicationId={applicationId} />
          <WorkflowsList applicationId={applicationId} />
          <RecentRuns applicationId={applicationId} />
        </div>
      </PermissionGate>
    </div>
  );
}
