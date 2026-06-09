"use client";

import {
  ChevronRightIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  PlayCircleIcon,
} from "@heroicons/react/24/outline";
import type { WorkflowRun } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { DetailPanel } from "@/components/detail-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, StatusDot } from "@/components/ui/status-badge";
import { useWorkflowRuns } from "@/lib/api/hooks/use-workflow-runs";
import { grantRunState, runStatusTone } from "@/lib/workflow/status";
import {
  formatDurationBetween,
  formatRelativeTime,
} from "@/lib/utils/format";
import { RetryRunButton } from "./retry-run-button";

/** The collapsed and expanded page sizes (ADR-0049: a short, scannable list, expand only on demand). */
const COLLAPSED_LIMIT = 6;
const EXPANDED_LIMIT = 50;

/**
 * The per-application recent runs panel (frontend.md §2a / §7a, polished per ADR-0049 — issue #307). The
 * observability entry point on the Workflows tab: the last runs for this app as richly-scannable rows —
 * a status dot + AA-toned pill (Fallido/Completado…), the trigger, a wall-clock duration, a "needs
 * attention" cue for failed/compensated runs, and a relative time — each a clearly clickable row → the
 * run-detail timeline (hover + focus affordance), so the panel reads as one feature with the timeline.
 * A FAILED row also offers an inline "Reintentar" (issue #308, `workflow:run`-gated). When there are more
 * runs than shown, a "ver todas" control expands the list inline (no separate page).
 */
export function RecentRuns({ applicationId }: { applicationId: string }) {
  const t = useTranslations("workflow");
  const [now] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useWorkflowRuns({
    applicationId,
    limit: expanded ? EXPANDED_LIMIT : COLLAPSED_LIMIT,
  });

  const runs = data?.items ?? [];
  const total = data?.total ?? runs.length;
  const hasMore = !expanded && total > runs.length;

  return (
    <DetailPanel title={t("runs.title")}>
      {isLoading ? (
        <div className="space-y-2.5">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : runs.length === 0 ? (
        <RecentRunsEmpty />
      ) : (
        <>
          <ul className="-mx-2 space-y-0.5">
            {runs.map((run) => (
              <RecentRunRow
                key={run.id}
                run={run}
                applicationId={applicationId}
                now={now}
              />
            ))}
          </ul>
          {hasMore ? (
            <div className="mt-3 border-t pt-3">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              >
                {t("runs.viewAll", { count: total })}
                <ChevronRightIcon className="size-4" />
              </button>
            </div>
          ) : null}
        </>
      )}
    </DetailPanel>
  );
}

/** One run row — a clickable link to the run detail, with the retry action layered on FAILED rows. */
function RecentRunRow({
  run,
  applicationId,
  now,
}: {
  run: WorkflowRun;
  applicationId: string;
  now: number;
}) {
  const t = useTranslations("workflow");
  const tone = runStatusTone(run.status);
  const needsAttention = grantRunState(run.status) === "needsAttention";
  const startedIso = run.startedAt ?? run.createdAt;
  const duration = formatDurationBetween(run.startedAt, run.finishedAt);

  return (
    <li>
      <Link
        href={`/applications/${applicationId}/workflows/runs/${run.id}`}
        className="group/run flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <StatusDot tone={tone} className="size-2" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={tone}>{t(`runStatus.${run.status}`)}</StatusBadge>
            <span className="truncate text-sm font-medium">
              {t(`triggers.${run.trigger}`)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 tabular-nums">
              <ClockIcon className="size-3" />
              {duration ?? t("runs.durationPending")}
            </span>
            {needsAttention ? (
              <span className="inline-flex items-center gap-1 font-medium text-destructive">
                <ExclamationTriangleIcon className="size-3" />
                {t("runs.needsAttention")}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Reintentar (issue #308) — renders only on a FAILED run for a workflow:run holder. */}
          <RetryRunButton
            runId={run.id}
            status={run.status}
            size="xs"
            variant="outline"
          />
          <span
            className="hidden text-xs tabular-nums text-muted-foreground sm:inline"
            title={new Date(startedIso).toLocaleString()}
          >
            {formatRelativeTime(startedIso, now)}
          </span>
          <ChevronRightIcon className="size-4 text-muted-foreground/60 transition-transform group-hover/run:translate-x-0.5 group-hover/run:text-muted-foreground" />
        </div>
      </Link>
    </li>
  );
}

/** A quiet, on-brand empty state — no runs yet (the common case for an app with no automation). */
function RecentRunsEmpty() {
  const t = useTranslations("workflow");
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
      <PlayCircleIcon className="size-7 text-muted-foreground/50" />
      <p className="text-sm font-medium">{t("runs.emptyTitle")}</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {t("runs.emptyDescription")}
      </p>
    </div>
  );
}
