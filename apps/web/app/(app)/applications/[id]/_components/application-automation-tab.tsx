"use client";

import { ShieldExclamationIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Callout } from "@/components/callout";
import { ConnectionCard } from "../workflows/_components/connection-card";
import { RecentRuns } from "../workflows/_components/recent-runs";
import { WorkflowsList } from "../workflows/_components/workflows-list";

/** The Workflows page's panels, in place; the parent renders this only for `workflow:read`. */
export function ApplicationAutomationTab({
  applicationId,
  isCritical,
}: {
  applicationId: string;
  isCritical: boolean;
}) {
  const t = useTranslations("applications.detail");
  return (
    <div className="space-y-4">
      {isCritical ? (
        <Callout tone="warning" icon={<ShieldExclamationIcon />}>
          <p className="text-sm">{t("critical.automation")}</p>
        </Callout>
      ) : null}
      <WorkflowsList applicationId={applicationId} />
      <RecentRuns applicationId={applicationId} />
      <ConnectionCard applicationId={applicationId} />
    </div>
  );
}
