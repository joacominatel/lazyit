"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { DetailPanel } from "@/components/detail-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useWorkflowRuns } from "@/lib/api/hooks/use-workflow-runs";
import { runStatusTone } from "@/lib/workflow/status";
import { formatRelativeTime } from "@/lib/utils/format";

/**
 * The per-application recent runs list (frontend.md §2a / §7a) — the last few runs for this app with
 * status pills, each linking to its run-detail timeline. This is the observability entry point on the
 * Workflows tab. A list does not need realtime (frontend.md §10) — it refetches on focus/navigation.
 */
export function RecentRuns({ applicationId }: { applicationId: string }) {
  const t = useTranslations("workflow");
  const [now] = useState(() => Date.now());
  const { data, isLoading } = useWorkflowRuns({ applicationId, limit: 8 });

  const runs = data?.items ?? [];

  return (
    <DetailPanel title={t("runs.title")}>
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("runs.empty")}</p>
      ) : (
        <ul className="divide-y">
          {runs.map((run) => (
            <li key={run.id}>
              <Link
                href={`/applications/${applicationId}/workflows/runs/${run.id}`}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 hover:bg-muted/30"
              >
                <span className="flex items-center gap-2">
                  <StatusBadge tone={runStatusTone(run.status)}>
                    {t(`runStatus.${run.status}`)}
                  </StatusBadge>
                  <span className="text-sm text-muted-foreground">
                    {t(`triggers.${run.trigger}`)}
                  </span>
                </span>
                <span
                  className="text-xs tabular-nums text-muted-foreground"
                  title={new Date(
                    run.startedAt ?? run.createdAt,
                  ).toLocaleString()}
                >
                  {formatRelativeTime(run.startedAt ?? run.createdAt, now)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DetailPanel>
  );
}
