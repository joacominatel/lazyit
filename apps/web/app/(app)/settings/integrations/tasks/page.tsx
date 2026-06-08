"use client";

import { useTranslations } from "next-intl";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { PermissionGate } from "@/components/permission-gate";
import { TasksInbox } from "../_components/tasks-inbox";

/**
 * The manual-task inbox page (frontend.md §2b/§6) — the cross-application queue of pending tasks that
 * need a human. Gated on `workflow:read` to view; acting on a task gates further on `workflow:task`
 * (enforced server-side). Polled, not realtime (the ADR-0052 SSE bell is a later phase).
 */
export default function WorkflowTasksPage() {
  const t = useTranslations("workflow");
  return (
    <div className="space-y-6">
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
                { label: t("inbox.title") },
              ]}
            />
          }
          title={t("inbox.title")}
          subtitle={t("inbox.subtitle")}
        />
        <TasksInbox />
      </PermissionGate>
    </div>
  );
}
