"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { useWorkflowRuns } from "@/lib/api/hooks/use-workflow-runs";
import { grantRunState, grantRunTone } from "@/lib/workflow/status";

/**
 * The grant↔run cross-link chip (frontend.md §7c). On the application's Active-access list, a grant whose
 * workflow ran gets a small derived-status chip ("Provisioned ✓" / "Provisioning…" / "Needs attention
 * ✗") linking to the run timeline — the visible payoff of the decoupled model (the grant action never
 * waited). Renders NOTHING when no run exists (the common case for an app with no automation), so it
 * stays quiet. The parent only mounts it when the caller holds `workflow:read`.
 */
export function GrantRunChip({
  applicationId,
  accessGrantId,
}: {
  applicationId: string;
  accessGrantId: string;
}) {
  const t = useTranslations("workflow");
  const { data } = useWorkflowRuns({ accessGrantId, limit: 1 });
  const run = data?.items[0];
  if (!run) return null;

  const state = grantRunState(run.status);
  return (
    <Link
      href={`/applications/${applicationId}/workflows/runs/${run.id}`}
      aria-label={t(`grantChip.${state}`)}
    >
      <StatusBadge tone={grantRunTone(run.status)}>
        {t(`grantChip.${state}`)}
      </StatusBadge>
    </Link>
  );
}
