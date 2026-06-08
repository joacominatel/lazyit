"use client";

import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { RequestIdNote } from "@/components/request-id-note";
import { StatusBadge } from "@/components/ui/status-badge";
import type {
  WorkflowRunDetail,
  WorkflowRunStep,
  WorkflowTransitionEdge,
} from "@/lib/api/endpoints/workflow-runs";
import { runStatusTone, stepStatusTone } from "@/lib/workflow/status";
import { formatRelativeTime } from "@/lib/utils/format";
import { WorkflowEdgeLabel, WorkflowNode } from "./workflow-graph";

/** Human-readable duration: sub-second in ms, else seconds with one decimal. */
function formatDuration(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** A failure edge is anything that is not a plain success continuation. */
const SUCCESS_EDGES: ReadonlySet<WorkflowTransitionEdge> = new Set([
  "NEXT",
  "GOTO",
  "END",
]);

/**
 * The run-detail timeline (frontend.md §7b) — the EXECUTED path through the DAG, drawn with the shared
 * graph primitives (the asset-history grammar). Per step it shows the status judged against the success
 * criteria (a 502 is a failure even though a response arrived), the attempt count, duration, the
 * external correlation id, and — the DAG addition — WHICH EDGE was taken, with the escalation /
 * compensation linkage rendered inline. All text is whatever the API returned (already redacted, INV-6);
 * the UI never un-redacts and renders every value as escaped text (SEC-A5).
 */
export function RunTimeline({ run }: { run: WorkflowRunDetail }) {
  const t = useTranslations("workflow");
  const [now] = useState(() => Date.now());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={runStatusTone(run.status)}>
          {t(`runStatus.${run.status}`)}
        </StatusBadge>
        <span className="text-sm text-muted-foreground">
          {t(`triggers.${run.trigger}`)}
        </span>
        {run.startedAt ? (
          <span
            className="ml-auto text-xs tabular-nums text-muted-foreground"
            title={new Date(run.startedAt).toLocaleString()}
          >
            {formatRelativeTime(run.startedAt, now)}
          </span>
        ) : null}
      </div>

      {run.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("runDetail.noSteps")}</p>
      ) : (
        <ol>
          {run.steps.map((step, index) => (
            <RunStepRow
              key={step.id}
              step={step}
              isLast={index === run.steps.length - 1}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function RunStepRow({
  step,
  isLast,
}: {
  step: WorkflowRunStep;
  isLast: boolean;
}) {
  const t = useTranslations("workflow");
  const duration = formatDuration(step.durationMs);
  const transition = step.transitionTaken;
  const isFailureEdge = transition ? !SUCCESS_EDGES.has(transition.edge) : false;

  const summaryParts: string[] = [];
  if (step.statusCode != null) {
    summaryParts.push(t("runDetail.httpStatus", { status: step.statusCode }));
  }
  if (step.errorClass) summaryParts.push(step.errorClass);
  summaryParts.push(t("runDetail.attempt", { attempt: step.attempt }));

  return (
    <>
      <WorkflowNode
        dotTone={stepStatusTone(step.status)}
        title={step.stepKey}
        summary={summaryParts.join(" · ")}
        meta={
          <span className="flex items-center gap-2">
            <StatusBadge tone={stepStatusTone(step.status)}>
              {t(`stepStatus.${step.status}`)}
            </StatusBadge>
            {duration ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {duration}
              </span>
            ) : null}
          </span>
        }
        isLast={isLast && transition == null}
      >
        {step.externalCorrelationId ? (
          <RequestIdNote
            requestId={step.externalCorrelationId}
            className="mt-2"
          />
        ) : null}
        {step.manualTaskId ? (
          <Link
            href={`/settings/integrations/tasks/${step.manualTaskId}`}
            className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {t("runDetail.openManualTask")}
            <ArrowTopRightOnSquareIcon className="size-3.5" />
          </Link>
        ) : null}
        {step.compensationStepKey ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("runDetail.compensatedWith", { step: step.compensationStepKey })}
          </p>
        ) : null}
      </WorkflowNode>

      {transition ? (
        <WorkflowEdgeLabel tone={isFailureEdge ? "danger" : "success"}>
          {t(
            isFailureEdge
              ? "runDetail.failureEdge"
              : "runDetail.successEdge",
            {
              edge: t(`edge.${transition.edge}`),
              target: transition.targetStepKey ?? "",
            },
          )}
        </WorkflowEdgeLabel>
      ) : null}
    </>
  );
}
