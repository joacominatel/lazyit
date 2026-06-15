"use client";

import {
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";
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
import { useFormatters } from "@/lib/hooks/use-formatters";
import { cn } from "@/lib/utils";
import { runStatusTone, stepStatusTone } from "@/lib/workflow/status";
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
 * compensation linkage rendered inline.
 *
 * Each step also carries a per-step REQUEST-DETAILS drawer (issue #343): the bounded `method` + the
 * target HOST (never the full URL with query) and the NAMES of the mapped fields (never their values),
 * so an operator can diagnose "which method + host did this hit, and which fields did it map?" without a
 * raw payload. Raw request/response bodies are NOT captured by design (INV-6 / ADR-0031) — the drawer
 * says so explicitly. All text is whatever the API returned (already redacted, INV-6); the UI never
 * un-redacts and renders every value as escaped text (SEC-A5).
 */
export function RunTimeline({ run }: { run: WorkflowRunDetail }) {
  const t = useTranslations("workflow");
  const { dateTime, relative } = useFormatters();

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
            title={dateTime(run.startedAt)}
          >
            {relative(run.startedAt)}
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
        <StepRequestDetails step={step} />
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

/**
 * The per-step REQUEST-DETAILS drawer (issue #343) — an expandable disclosure surfacing the already
 * persisted, REDACTED request shape: the bounded `method` + target HOST (never the full URL with its
 * query) and the NAMES of the mapped fields (never their values, INV-6). It also states plainly that
 * raw request/response BODIES are NOT captured by design, so the operator knows the absence is
 * deliberate, not a gap. Renders nothing when the step carries none of these (e.g. a MANUAL step).
 */
function StepRequestDetails({ step }: { step: WorkflowRunStep }) {
  const t = useTranslations("workflow");
  const [open, setOpen] = useState(false);
  const hasRequestShape = step.method != null || step.targetHost != null;
  const hasMappedFields = step.mappedFields.length > 0;

  // Nothing to show — keep the row clean (a MANUAL step records no method/host/mapped fields).
  if (!hasRequestShape && !hasMappedFields) {
    return null;
  }

  // The request line: "POST · api.jira.example.com" (whichever parts the engine recorded).
  const requestLine = [step.method, step.targetHost]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        {t("runDetail.requestDetails")}
      </button>

      {open ? (
        <div className="mt-2 space-y-2 border-l pl-3">
          {requestLine ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t("runDetail.request")}
              </p>
              {/* SEC-A5: redacted (method + host only) — rendered as escaped text. */}
              <code className="font-mono text-xs break-all">{requestLine}</code>
            </div>
          ) : null}

          {hasMappedFields ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t("runDetail.mappedFields")}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {step.mappedFields.map((field) => (
                  <code
                    key={field}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all"
                  >
                    {field}
                  </code>
                ))}
              </div>
            </div>
          ) : null}

          {/* The redaction invariant made explicit — bodies are intentionally never captured. */}
          <p className="text-xs text-muted-foreground/80 italic">
            {t("runDetail.noPayloadsByDesign")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
