"use client";

import { ArrowPathIcon, BeakerIcon } from "@heroicons/react/24/outline";
import type { User, WorkflowStep, WorkflowTriggerV1 } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  DryRunResult,
  WorkflowDryRunInput,
} from "@/lib/api/endpoints/workflow-runs";
import { useApplicationGrants } from "@/lib/api/hooks/use-applications";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useDryRunWorkflow } from "@/lib/api/hooks/use-workflow-runs";
import { notifyError } from "@/lib/api/notify-error";
import { DryRunTimeline } from "./dry-run-timeline";

/**
 * C4 — the "Test run (dry-run)" dialog (frontend.md §8). Picks a real sample grant (the most-recent
 * active grant for this app by default), optionally forces ONE step to FAILURE to preview its failure
 * edge, then resolves the would-be requests + DAG traversal with NO side effects and renders them via
 * {@link DryRunTimeline}. Gated `workflow:manage` (mounted only for a manage holder by the builder).
 *
 * The dry-run runs against the SAVED/pinned latest version, so it is only offered once a workflow has
 * been saved (the builder passes a `workflowId`). The `steps` here drive the simulate picker; if a key
 * no longer matches the saved version the API returns a clean 400, surfaced via {@link notifyError}.
 */
export function DryRunDialog({
  open,
  onOpenChange,
  workflowId,
  applicationId,
  trigger,
  steps,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string;
  applicationId: string;
  trigger: WorkflowTriggerV1;
  steps: WorkflowStep[];
}) {
  const t = useTranslations("workflow");
  const tc = useTranslations("common");

  const { data: grants } = useApplicationGrants(applicationId, {
    activeOnly: true,
  });
  const { data: users } = useUsers();
  const dryRun = useDryRunWorkflow();

  const userById = useMemo(
    () => new Map<string, User>((users ?? []).map((u) => [u.id, u])),
    [users],
  );

  const activeGrants = grants ?? [];

  const [grantId, setGrantId] = useState<string>("");
  const [simulateEnabled, setSimulateEnabled] = useState(false);
  const [simulateStepKey, setSimulateStepKey] = useState<string>("");
  const [result, setResult] = useState<DryRunResult | null>(null);

  // Default to the most-recent active grant / first step until the operator picks another.
  const selectedGrantId = grantId || activeGrants[0]?.id || "";
  const selectedStepKey = simulateStepKey || steps[0]?.key || "";

  function grantLabel(userId: string, accessLevel: string | null): string {
    const user = userById.get(userId);
    const name = user
      ? `${user.firstName} ${user.lastName}`
      : t("dryRun.unknownUser");
    return accessLevel ? `${name} · ${accessLevel}` : name;
  }

  function run() {
    if (!selectedGrantId) return;
    const body: WorkflowDryRunInput = {
      workflowId,
      sampleAccessGrantId: selectedGrantId,
      ...(simulateEnabled && selectedStepKey
        ? { simulate: { stepKey: selectedStepKey, outcome: "FAILURE" } }
        : {}),
    };
    dryRun.mutate(body, {
      onSuccess: (outcome) => setResult(outcome),
      onError: (error) => notifyError(error, t("dryRun.error")),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("dryRun.title")}</DialogTitle>
          <DialogDescription>{t("dryRun.description")}</DialogDescription>
        </DialogHeader>

        {/* The forced trigger is implicit (the workflow's own trigger); shown for context only. */}
        <input type="hidden" value={trigger} readOnly />

        <div className="space-y-4">
          {activeGrants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("dryRun.noGrants")}
            </p>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="dry-run-grant">
                  {t("dryRun.sampleGrant")}
                </FieldLabel>
                <Select
                  value={selectedGrantId || undefined}
                  onValueChange={setGrantId}
                >
                  <SelectTrigger id="dry-run-grant">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {activeGrants.map((grant) => (
                      <SelectItem key={grant.id} value={grant.id}>
                        {grantLabel(grant.userId, grant.accessLevel)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {t("dryRun.sampleGrantHint")}
                </FieldDescription>
              </Field>

              {steps.length > 0 ? (
                <Field>
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel htmlFor="dry-run-simulate">
                      {t("dryRun.simulateLabel")}
                    </FieldLabel>
                    <Switch
                      id="dry-run-simulate"
                      checked={simulateEnabled}
                      onCheckedChange={setSimulateEnabled}
                      aria-label={t("dryRun.simulateLabel")}
                    />
                  </div>
                  <FieldDescription>
                    {t("dryRun.simulateHint")}
                  </FieldDescription>
                  {simulateEnabled ? (
                    <Select
                      value={selectedStepKey || undefined}
                      onValueChange={setSimulateStepKey}
                    >
                      <SelectTrigger
                        id="dry-run-simulate-step"
                        aria-label={t("dryRun.simulateStep")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {steps.map((step) => (
                          <SelectItem key={step.key} value={step.key}>
                            {step.name || step.key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </Field>
              ) : null}

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={dryRun.isPending}
                >
                  {tc("close")}
                </Button>
                <Button
                  type="button"
                  onClick={run}
                  disabled={dryRun.isPending || !selectedGrantId}
                >
                  {dryRun.isPending ? (
                    <ArrowPathIcon className="animate-spin" />
                  ) : (
                    <BeakerIcon />
                  )}
                  {t("dryRun.run")}
                </Button>
              </div>
            </>
          )}

          {result ? (
            <div className="border-t pt-4">
              <DryRunTimeline result={result} />
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
