"use client";

import { CheckIcon } from "@heroicons/react/24/outline";
import type { ImportDryRunReport } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useImportSession } from "@/lib/api/hooks/use-imports";
import { CommitStep } from "./steps/commit-step";
import { ConflictsStep } from "./steps/conflicts-step";
import { MappingStep } from "./steps/mapping-step";
import { PreviewStep } from "./steps/preview-step";
import { SummaryStep } from "./steps/summary-step";
import { UploadStep } from "./steps/upload-step";

/**
 * The guided bulk Migrator wizard orchestrator (ADR-0069 §1, #637). It owns the only durable handle —
 * the `sessionId` — plus the locally-accumulated dry-run report and resolution plan, and walks the
 * operator through the fixed five-step shape: upload → summary → mapping → preview → conflicts →
 * commit. No human is ever in the loop mid-commit; the plan is frozen before the async commit runs.
 *
 * The session view is POLLED here (one shared query) so every step reads the same server truth. Step
 * transitions are explicit (a step calls `goTo` after its mutation resolves) rather than inferred, so
 * a slow poll never bounces the operator forward; the session status is the guard, the local step is
 * the position.
 */

const STEP_ORDER = [
  "upload",
  "summary",
  "mapping",
  "preview",
  "conflicts",
  "commit",
] as const;
export type WizardStep = (typeof STEP_ORDER)[number];

export function ImportWizard() {
  const t = useTranslations("imports");

  const [sessionId, setSessionId] = useState<string | undefined>();
  const [step, setStep] = useState<WizardStep>("upload");
  // The dry-run report is the input to the conflict step; held locally so navigating back/forward
  // between preview and conflicts doesn't re-run the (server-side, idempotent) dry-run needlessly.
  const [report, setReport] = useState<ImportDryRunReport | null>(null);

  const session = useImportSession(sessionId);

  function reset() {
    setSessionId(undefined);
    setStep("upload");
    setReport(null);
  }

  function goTo(next: WizardStep) {
    setStep(next);
  }

  const currentIndex = STEP_ORDER.indexOf(step);

  return (
    <div className="space-y-6">
      <Stepper currentIndex={currentIndex} t={t} />

      <Card>
        <CardContent className="pt-6">
          {step === "upload" && (
            <UploadStep
              onParsed={(id) => {
                setSessionId(id);
                goTo("summary");
              }}
            />
          )}

          {step === "summary" && (
            <SummaryStep
              session={session.data}
              isLoading={session.isLoading}
              error={session.error}
              onBack={reset}
              onContinue={() => goTo("mapping")}
            />
          )}

          {step === "mapping" && sessionId && session.data && (
            <MappingStep
              sessionId={sessionId}
              session={session.data}
              onBack={() => goTo("summary")}
              onMapped={(dryRunReport) => {
                setReport(dryRunReport);
                goTo("preview");
              }}
            />
          )}

          {step === "preview" && report && (
            <PreviewStep
              report={report}
              onBack={() => goTo("mapping")}
              onContinue={() => goTo("conflicts")}
            />
          )}

          {step === "conflicts" && sessionId && report && (
            <ConflictsStep
              sessionId={sessionId}
              report={report}
              onBack={() => goTo("preview")}
              onPlanned={() => goTo("commit")}
            />
          )}

          {step === "commit" && sessionId && (
            <CommitStep
              sessionId={sessionId}
              sessionStatus={session.data?.status}
              onImportMore={reset}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The wizard progress rail — a row of numbered steps with the current one highlighted and completed
 * ones checked. Decorative + informational (the heading order is the real progress); `aria-current`
 * marks the active step for assistive tech.
 */
function Stepper({
  currentIndex,
  t,
}: {
  currentIndex: number;
  t: ReturnType<typeof useTranslations<"imports">>;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm" aria-label={t("title")}>
      {STEP_ORDER.map((stepKey, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li key={stepKey} className="flex items-center gap-2">
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium",
                active && "bg-primary/10 text-primary",
                done && "text-muted-foreground",
                !active && !done && "text-muted-foreground/60",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-xs",
                  active && "bg-primary text-primary-foreground",
                  done && "bg-muted text-muted-foreground",
                  !active && !done && "border border-current",
                )}
                aria-hidden="true"
              >
                {done ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              {t(`steps.${stepKey}` as Parameters<typeof t>[0])}
            </span>
            {index < STEP_ORDER.length - 1 && (
              <span className="text-muted-foreground/40" aria-hidden="true">
                ·
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
