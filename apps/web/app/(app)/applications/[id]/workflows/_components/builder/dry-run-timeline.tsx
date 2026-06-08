"use client";

import { BeakerIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { RequestIdNote } from "@/components/request-id-note";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import type {
  DryRunEndState,
  DryRunRequestPreview,
  DryRunResult,
  DryRunStep,
  WorkflowTransitionEdge,
} from "@/lib/api/endpoints/workflow-runs";
import { stepStatusTone } from "@/lib/workflow/status";
import {
  StepKindBadge,
  WorkflowEdgeLabel,
  WorkflowNode,
  WorkflowTerminal,
} from "../workflow-graph";

/** A failure edge is anything that is not a plain success continuation (matches the run timeline). */
const SUCCESS_EDGES: ReadonlySet<WorkflowTransitionEdge> = new Set([
  "NEXT",
  "GOTO",
  "END",
]);

/** The terminal each dry-run end-state closes the spine with (the five AA-safe tones, ADR-0049 §4). */
const END_STATE_TONE: Record<DryRunEndState, StatusTone> = {
  END_SUCCESS: "success",
  STOP_FAIL: "danger",
  ESCALATE_TO_MANUAL: "warning",
  COMPENSATE: "warning",
};

/**
 * The DRY-RUN result rendered in the run-timeline grammar (frontend.md §8) — the would-be traversal of
 * the authored DAG against a real sample grant, with NO side effects. A loud "DRY RUN" banner makes it
 * unmistakable that nothing was provisioned. Per step it shows the resolved would-be request
 * (method/url/headers/body preview), the mapped field names, the transition edge that would be taken,
 * the assumed status, and any warnings; the spine closes on the `endState` terminal + a `wouldPause`
 * note.
 *
 * SEC-A5: the result carries resolved grantee PII, would-be request bodies and `‹secret:label›`
 * placeholders — EVERY value is rendered as escaped text (React children), never as raw HTML, and a
 * `‹secret:…›` placeholder is shown verbatim (never un-redacted).
 */
export function DryRunTimeline({ result }: { result: DryRunResult }) {
  const t = useTranslations("workflow");
  const { context } = result;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
        <StatusBadge tone="warning">
          <BeakerIcon />
          {t("dryRun.banner")}
        </StatusBadge>
        <span className="text-xs text-muted-foreground">
          {t("dryRun.bannerHint")}
        </span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {t("dryRun.version", { version: result.version })}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-2">
        <DryRunContextRow label={t("dryRun.grantee")}>
          {/* SEC-A5: untrusted grantee name/email rendered as escaped text. */}
          {context.grantee.firstName} {context.grantee.lastName}
          <span className="text-muted-foreground"> · {context.grantee.email}</span>
        </DryRunContextRow>
        <DryRunContextRow label={t("dryRun.application")}>
          {context.application.name}
        </DryRunContextRow>
        <DryRunContextRow label={t("dryRun.event")}>
          {t(`triggers.${context.event}`)}
        </DryRunContextRow>
        <DryRunContextRow label={t("dryRun.accessLevel")}>
          {context.grant.accessLevel ?? t("dryRun.accessLevelNone")}
        </DryRunContextRow>
      </dl>

      {result.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("dryRun.noSteps")}</p>
      ) : (
        <ol>
          {result.steps.map((step) => (
            <DryRunStepRow key={`${step.stepIndex}-${step.stepKey}`} step={step} />
          ))}
          <WorkflowTerminal
            tone={END_STATE_TONE[result.endState]}
            label={t(`dryRun.endState.${result.endState}`)}
          />
        </ol>
      )}

      {result.wouldPause ? (
        <p className="text-sm text-warning">{t("dryRun.wouldPause")}</p>
      ) : null}

      <RequestIdNote requestId={result.requestId} />
    </div>
  );
}

function DryRunContextRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function DryRunStepRow({ step }: { step: DryRunStep }) {
  const t = useTranslations("workflow");
  const transition = step.transitionTaken;
  const isFailureEdge = transition ? !SUCCESS_EDGES.has(transition.edge) : false;

  return (
    <>
      <WorkflowNode
        dotTone={stepStatusTone(step.status)}
        badge={<StepKindBadge kind={step.kind} />}
        title={step.name || step.stepKey}
        meta={
          <span className="flex items-center gap-2">
            {step.simulated ? (
              <StatusBadge tone="warning">{t("dryRun.simulated")}</StatusBadge>
            ) : null}
            <StatusBadge tone={stepStatusTone(step.status)}>
              {t(`stepStatus.${step.status}`)}
            </StatusBadge>
          </span>
        }
        isLast={false}
      >
        {step.request ? <DryRunRequest request={step.request} /> : null}

        {step.mappedFields.length > 0 ? (
          <div className="mt-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t("dryRun.mappedFields")}
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

        {step.manual ? (
          <div className="mt-2 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t("dryRun.manualPrompt")}
            </p>
            {/* SEC-A5: admin-typed prompt rendered as escaped text only. */}
            <p className="text-sm break-words whitespace-pre-wrap">
              {step.manual.prompt}
            </p>
            {step.manual.inputFields.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {step.manual.inputFields.map((f) => (
                  <li key={f.name} className="text-xs text-muted-foreground">
                    {/* SEC-A5: admin-typed label rendered as escaped text only. */}
                    {f.label}
                    {f.required ? " *" : ""}
                    <span className="text-muted-foreground/70">
                      {" "}
                      · {t(`fieldType.${f.type}`)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {step.warnings.length > 0 ? (
          <ul className="mt-2 space-y-0.5">
            {step.warnings.map((warning) => (
              <li key={warning} className="text-xs text-warning break-words">
                {/* SEC-A5: advisory text rendered as escaped text only. */}
                {warning}
              </li>
            ))}
          </ul>
        ) : null}
      </WorkflowNode>

      {transition ? (
        <WorkflowEdgeLabel tone={isFailureEdge ? "danger" : "success"}>
          {t(isFailureEdge ? "runDetail.failureEdge" : "runDetail.successEdge", {
            edge: t(`edge.${transition.edge}`),
            target: transition.targetStepKey ?? "",
          })}
        </WorkflowEdgeLabel>
      ) : null}
    </>
  );
}

function DryRunRequest({ request }: { request: DryRunRequestPreview }) {
  const t = useTranslations("workflow");
  const headerEntries = Object.entries(request.headers);
  const bodyEntries = request.body ? Object.entries(request.body) : [];

  return (
    <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2.5">
      <p className="font-mono text-xs break-all">
        <span className="font-semibold">{request.method}</span> {request.url}
        {request.signed ? (
          <StatusBadge tone="info" className="ml-2 align-middle">
            {t("dryRun.signed")}
          </StatusBadge>
        ) : null}
      </p>

      {headerEntries.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {t("dryRun.headers")}
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {headerEntries.map(([key, value]) => (
              <li key={key} className="font-mono text-xs break-all">
                {/* SEC-A5: header values may carry ‹secret:label› placeholders — escaped text only. */}
                <span className="text-muted-foreground">{key}:</span> {value}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {bodyEntries.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {t("dryRun.body")}
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {bodyEntries.map(([key, value]) => (
              <li key={key} className="font-mono text-xs break-all">
                {/* SEC-A5: resolved body leaves rendered as escaped text only. */}
                <span className="text-muted-foreground">{key}:</span> {value}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
