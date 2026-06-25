"use client";

import {
  ArrowDownIcon,
  ArrowPathIcon,
  ArrowUpIcon,
  BeakerIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  resolveStepTransitions,
  WORKFLOW_DEPROVISION_POLICIES,
  WORKFLOW_END_SUCCESS,
  WORKFLOW_ESCALATE_TO_MANUAL,
  WORKFLOW_STOP_FAIL,
  WORKFLOW_TRIGGERS_V1,
  type WorkflowDeprovisionPolicy,
  type WorkflowStep,
  WorkflowStepsSchema,
  type WorkflowTriggerV1,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useReducer } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailField, DetailPanel } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  parseWorkflowGraphError,
  type WorkflowWithVersion,
} from "@/lib/api/endpoints/workflows";
import { useWorkflowConnections } from "@/lib/api/hooks/use-workflow-connections";
import {
  useCreateWorkflow,
  useCreateWorkflowVersion,
  useUpdateWorkflow,
} from "@/lib/api/hooks/use-workflow-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { useCan } from "@/lib/hooks/use-permissions";
import { selectActiveConnection } from "@/lib/workflow/connection-select";
import { createStep, nextStepKey, type StepKind } from "@/lib/workflow/step-form";
import { cn } from "@/lib/utils";
import {
  StepKindBadge,
  WorkflowEdgeLabel,
  WorkflowNode,
  WorkflowTerminal,
} from "../workflow-graph";
import { DryRunDialog } from "./dry-run-dialog";
import { StepEditor } from "./step-editor";
import { StepPalette } from "./step-palette";

/** A one-line summary of a step for its diagram box. */
function stepSummary(step: WorkflowStep): string {
  switch (step.kind) {
    case "REST":
      return `${step.method} ${step.path}`;
    case "WEBHOOK_OUT":
      return "POST · webhook";
    case "MANUAL":
      return step.prompt || "—";
  }
}

/** The editable workflow document (header fields + the ordered `steps` array). Grouped into one typed
 *  reducer so the builder stays under the prefer-useReducer budget; every transition mirrors the
 *  original setSteps/setName/… logic exactly (the `moveStep` splice and functional updates included). */
type WorkflowDraft = {
  workflowId: string | undefined;
  name: string;
  trigger: WorkflowTriggerV1;
  enabled: boolean;
  deprovisionPolicy: WorkflowDeprovisionPolicy;
  steps: WorkflowStep[];
};

type WorkflowDraftAction =
  | { type: "setWorkflowId"; workflowId: string }
  | { type: "setName"; name: string }
  | { type: "setTrigger"; trigger: WorkflowTriggerV1 }
  | { type: "setEnabled"; enabled: boolean }
  | { type: "setDeprovisionPolicy"; policy: WorkflowDeprovisionPolicy }
  | { type: "appendStep"; step: WorkflowStep }
  | { type: "replaceStep"; index: number; step: WorkflowStep }
  | { type: "removeStep"; index: number }
  | { type: "moveStep"; index: number; delta: number };

function workflowDraftReducer(
  state: WorkflowDraft,
  action: WorkflowDraftAction,
): WorkflowDraft {
  switch (action.type) {
    case "setWorkflowId":
      return { ...state, workflowId: action.workflowId };
    case "setName":
      return { ...state, name: action.name };
    case "setTrigger":
      return { ...state, trigger: action.trigger };
    case "setEnabled":
      return { ...state, enabled: action.enabled };
    case "setDeprovisionPolicy":
      return { ...state, deprovisionPolicy: action.policy };
    case "appendStep":
      return { ...state, steps: [...state.steps, action.step] };
    case "replaceStep":
      return {
        ...state,
        steps: state.steps.map((s, i) => (i === action.index ? action.step : s)),
      };
    case "removeStep":
      return { ...state, steps: state.steps.filter((_, i) => i !== action.index) };
    case "moveStep": {
      const target = action.index + action.delta;
      if (target < 0 || target >= state.steps.length) return state;
      const next = [...state.steps];
      const [item] = next.splice(action.index, 1);
      if (item) next.splice(target, 0, item);
      return { ...state, steps: next };
    }
  }
}

/** Transient editor UI (which step is being edited, the flagged-invalid set, the save error and the
 *  dry-run dialog). Kept separate from {@link WorkflowDraft} — view state, not the saved document. */
type WorkflowEditorState = {
  editingIndex: number | null;
  invalidSteps: ReadonlySet<number>;
  saveError: string | undefined;
  dryRunOpen: boolean;
};

type WorkflowEditorAction =
  | { type: "openEditor"; index: number }
  | { type: "closeEditor" }
  | { type: "setInvalidSteps"; steps: ReadonlySet<number> }
  | { type: "setSaveError"; error: string | undefined }
  | { type: "setDryRunOpen"; open: boolean };

function workflowEditorReducer(
  state: WorkflowEditorState,
  action: WorkflowEditorAction,
): WorkflowEditorState {
  switch (action.type) {
    case "openEditor":
      return { ...state, editingIndex: action.index };
    case "closeEditor":
      return { ...state, editingIndex: null };
    case "setInvalidSteps":
      return { ...state, invalidSteps: action.steps };
    case "setSaveError":
      return { ...state, saveError: action.error };
    case "setDryRunOpen":
      return { ...state, dryRunOpen: action.open };
  }
}

/**
 * The workflow builder (frontend.md §3) — the opinionated error-handling DAG editor. The header
 * (name/trigger/enabled/deprovision) + an ordered `steps` array (a degenerate sequence by default) are
 * held in local state; the diagram RENDERS that array + its resolved transitions (the array IS the
 * graph — there is no free edge-drawing). Save authors a new immutable version
 * (`POST /workflows/:id/versions`); the backend validates the whole graph and returns field-addressable
 * 400s, which {@link parseWorkflowGraphError} maps onto the offending boxes. Gated on `workflow:manage`.
 */
export function WorkflowBuilder({
  applicationId,
  applicationName,
  workflow,
}: {
  applicationId: string;
  applicationName: string;
  /** Present → edit an existing workflow; absent → author a new one. */
  workflow?: WorkflowWithVersion;
}) {
  const t = useTranslations("workflow");
  const tc = useTranslations("common");
  const router = useRouter();
  const canManage = useCan("workflow:manage");

  const { data: connections } = useWorkflowConnections(applicationId);
  const connection = selectActiveConnection(connections);

  const createWorkflow = useCreateWorkflow();
  const updateWorkflow = useUpdateWorkflow();
  const createVersion = useCreateWorkflowVersion();
  const isSaving =
    createWorkflow.isPending ||
    updateWorkflow.isPending ||
    createVersion.isPending;

  // Initial state is derived from `workflow` on first mount; React keeps the reducer's own state
  // thereafter (the object recomputed on later renders is discarded), matching the original useState seeds.
  const [draft, dispatchDraft] = useReducer(workflowDraftReducer, {
    workflowId: workflow?.id,
    name: workflow?.name ?? "",
    trigger: (workflow?.trigger as WorkflowTriggerV1) ?? "ACCESS_GRANTED",
    enabled: workflow?.enabled ?? false,
    deprovisionPolicy: workflow?.deprovisionPolicy ?? "LAST_ACTIVE_GRANT",
    steps: workflow?.latestVersion?.steps ?? [],
  });
  const { workflowId, name, trigger, enabled, deprovisionPolicy, steps } = draft;

  const [editor, dispatchEditor] = useReducer(workflowEditorReducer, {
    editingIndex: null,
    invalidSteps: new Set<number>(),
    saveError: undefined,
    dryRunOpen: false,
  });
  const { editingIndex, invalidSteps, saveError, dryRunOpen } = editor;

  const isEdit = workflow != null;

  // Stable element for the PageHeader `breadcrumb` slot (jsx-no-jsx-as-prop).
  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: t("breadcrumb.applications"), href: "/applications" },
          {
            label: applicationName,
            href: `/applications/${applicationId}`,
          },
          {
            label: t("breadcrumb.workflows"),
            href: `/applications/${applicationId}/workflows`,
          },
          { label: isEdit ? t("builder.editTitle") : t("builder.newTitle") },
        ]}
      />
    ),
    [t, applicationName, applicationId, isEdit],
  );

  function addStep(kind: StepKind) {
    if (kind !== "MANUAL" && !connection) {
      toast.error(t("builder.connectionRequired"));
      return;
    }
    const key = nextStepKey(steps);
    dispatchDraft({
      type: "appendStep",
      step: createStep(kind, key, connection?.id ?? ""),
    });
  }

  function saveStep(index: number, next: WorkflowStep) {
    dispatchDraft({ type: "replaceStep", index, step: next });
    dispatchEditor({ type: "closeEditor" });
  }

  function removeStep(index: number) {
    dispatchDraft({ type: "removeStep", index });
  }

  function move(index: number, delta: number) {
    dispatchDraft({ type: "moveStep", index, delta });
  }

  async function save() {
    if (name.trim().length === 0) {
      dispatchEditor({ type: "setSaveError", error: t("builder.nameRequired") });
      return;
    }
    const parsed = WorkflowStepsSchema.safeParse(steps);
    if (!parsed.success) {
      dispatchEditor({ type: "setSaveError", error: t("builder.invalidSteps") });
      return;
    }
    dispatchEditor({ type: "setSaveError", error: undefined });
    dispatchEditor({ type: "setInvalidSteps", steps: new Set() });

    try {
      let id = workflowId;
      if (!id) {
        const created = await createWorkflow.mutateAsync({
          applicationId,
          trigger,
          name: name.trim(),
          enabled,
          deprovisionPolicy,
        });
        id = created.id;
        dispatchDraft({ type: "setWorkflowId", workflowId: id });
      } else {
        await updateWorkflow.mutateAsync({
          id,
          data: { name: name.trim(), enabled, deprovisionPolicy },
        });
      }

      try {
        await createVersion.mutateAsync({ id, data: { steps: parsed.data } });
      } catch (versionError) {
        const graphError = parseWorkflowGraphError(versionError);
        if (graphError) {
          const flagged = new Set<number>();
          for (const s of graphError.unreachableSteps ?? []) flagged.add(s.index);
          if (graphError.stepIndex !== undefined) flagged.add(graphError.stepIndex);
          dispatchEditor({ type: "setInvalidSteps", steps: flagged });
          dispatchEditor({ type: "setSaveError", error: graphError.message });
          // The header now exists — keep editing this workflow so a re-save is an update.
          router.replace(`/applications/${applicationId}/workflows/${id}/edit`);
          return;
        }
        throw versionError;
      }

      toast.success(t("builder.toastSaved"));
      router.push(`/applications/${applicationId}/workflows/${id}/edit`);
    } catch (error) {
      notifyError(error, t("builder.toastError"));
    }
  }

  const editingStep = editingIndex != null ? steps[editingIndex] : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={breadcrumb}
        title={isEdit ? name || t("builder.editTitle") : t("builder.newTitle")}
        subtitle={t("builder.subtitle")}
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={enabled}
                onCheckedChange={(checked) =>
                  dispatchDraft({ type: "setEnabled", enabled: checked })
                }
                disabled={!canManage}
                aria-label={t("builder.enabledAria")}
              />
              {enabled ? t("builder.enabled") : t("builder.disabled")}
            </label>
            {canManage && workflowId ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => dispatchEditor({ type: "setDryRunOpen", open: true })}
              >
                <BeakerIcon />
                {t("dryRun.button")}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <Link href={`/applications/${applicationId}/workflows`}>
                {tc("cancel")}
              </Link>
            </Button>
            <Button size="sm" onClick={save} disabled={!canManage || isSaving}>
              {isSaving && <ArrowPathIcon className="animate-spin" />}
              {t("builder.save")}
            </Button>
          </div>
        }
      />

      <DetailPanel title={t("builder.detailsTitle")}>
        <div className="space-y-4">
          <Field>
            <FieldLabel htmlFor="wf-name">{t("builder.nameLabel")}</FieldLabel>
            <Input
              id="wf-name"
              value={name}
              onChange={(e) =>
                dispatchDraft({ type: "setName", name: e.target.value })
              }
              placeholder={t("builder.namePlaceholder")}
              maxLength={120}
              disabled={!canManage}
            />
          </Field>

          <Field>
            <FieldLabel>{t("builder.triggerLabel")}</FieldLabel>
            <FieldDescription>{t("builder.triggerHint")}</FieldDescription>
            <div className="flex flex-wrap gap-2">
              {WORKFLOW_TRIGGERS_V1.map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={isEdit || !canManage}
                  onClick={() => dispatchDraft({ type: "setTrigger", trigger: value })}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-sm transition-colors disabled:opacity-60",
                    trigger === value
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "hover:bg-muted/40",
                  )}
                >
                  {t(`triggers.${value}`)}
                </button>
              ))}
            </div>
            {isEdit ? (
              <FieldDescription>{t("builder.triggerImmutable")}</FieldDescription>
            ) : null}
          </Field>

          {trigger === "ACCESS_REVOKED" ? (
            <Field className="max-w-xs">
              <FieldLabel htmlFor="wf-deprovision">
                {t("builder.deprovisionLabel")}
              </FieldLabel>
              <Select
                value={deprovisionPolicy}
                onValueChange={(v) =>
                  dispatchDraft({
                    type: "setDeprovisionPolicy",
                    policy: v as WorkflowDeprovisionPolicy,
                  })
                }
                disabled={!canManage}
              >
                <SelectTrigger id="wf-deprovision">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKFLOW_DEPROVISION_POLICIES.map((policy) => (
                    <SelectItem key={policy} value={policy}>
                      {t(`deprovision.${policy}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          <DetailField label={t("builder.connectionLabel")}>
            {connection ? (
              <span className="inline-flex items-center gap-2">
                <StepKindBadge kind={connection.kind} />
                {connection.name}
              </span>
            ) : (
              <Link
                href={`/applications/${applicationId}/workflows`}
                className="text-sm text-primary hover:underline"
              >
                {t("builder.connectionMissing")}
              </Link>
            )}
          </DetailField>
        </div>
      </DetailPanel>

      <DetailPanel
        title={t("builder.stepsTitle")}
        actions={canManage ? <StepPalette onAdd={addStep} /> : undefined}
      >
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("builder.noSteps")}</p>
        ) : (
          <ol>
            <WorkflowNode
              dotTone="info"
              title={t("builder.triggerNode", {
                trigger: t(`triggers.${trigger}`),
              })}
              isLast={false}
            />
            {steps.map((step, index) => {
              const resolved = resolveStepTransitions(steps, index);
              const nextKey = steps[index + 1]?.key;
              const failureLabel = failureEdgeLabel(resolved.onFailure, t);
              const successLabel = successEdgeLabel(
                resolved.onSuccess,
                nextKey,
                t,
              );
              return (
                <StepDiagramRow
                  key={step.key}
                  step={step}
                  index={index}
                  total={steps.length}
                  invalid={invalidSteps.has(index)}
                  canManage={canManage}
                  failureLabel={failureLabel}
                  successLabel={successLabel}
                  onOpen={() => dispatchEditor({ type: "openEditor", index })}
                  onMoveUp={() => move(index, -1)}
                  onMoveDown={() => move(index, 1)}
                  onRemove={() => removeStep(index)}
                />
              );
            })}
            <WorkflowTerminal tone="success" label={t("edgeLabel.endSuccess")} />
          </ol>
        )}
        {saveError ? (
          <div className="mt-4">
            <FieldError errors={[{ message: saveError }]} />
          </div>
        ) : null}
      </DetailPanel>

      {editingStep ? (
        <StepEditor
          open={editingIndex != null}
          step={editingStep}
          otherSteps={steps.filter((_, i) => i !== editingIndex)}
          priorSteps={steps.slice(0, editingIndex ?? 0)}
          onSave={(next) => saveStep(editingIndex as number, next)}
          onClose={() => dispatchEditor({ type: "closeEditor" })}
        />
      ) : null}

      {canManage && workflowId ? (
        <DryRunDialog
          open={dryRunOpen}
          onOpenChange={(open) => dispatchEditor({ type: "setDryRunOpen", open })}
          workflowId={workflowId}
          applicationId={applicationId}
          trigger={trigger}
          steps={steps}
        />
      ) : null}
    </div>
  );
}

function StepDiagramRow({
  step,
  index,
  total,
  invalid,
  canManage,
  failureLabel,
  successLabel,
  onOpen,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  invalid: boolean;
  canManage: boolean;
  failureLabel: string | null;
  successLabel: string | null;
  onOpen: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations("workflow");
  return (
    <>
      <WorkflowNode
        dotTone={invalid ? "danger" : "neutral"}
        invalid={invalid}
        badge={<StepKindBadge kind={step.kind} />}
        title={step.name || step.key}
        summary={stepSummary(step)}
        onClick={onOpen}
        ariaLabel={t("builder.editStepAria", { name: step.name || step.key })}
        isLast={false}
        actions={
          canManage ? (
            <>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={onMoveUp}
                disabled={index === 0}
                aria-label={t("builder.moveUpAria")}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={onMoveDown}
                disabled={index === total - 1}
                aria-label={t("builder.moveDownAria")}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={onRemove}
                aria-label={t("builder.removeStepAria")}
              >
                <TrashIcon />
              </Button>
            </>
          ) : undefined
        }
      />
      {successLabel ? (
        <WorkflowEdgeLabel tone="success">{successLabel}</WorkflowEdgeLabel>
      ) : null}
      {failureLabel ? (
        <WorkflowEdgeLabel tone="danger">{failureLabel}</WorkflowEdgeLabel>
      ) : null}
    </>
  );
}

/** Label for a non-default failure edge (STOP_FAIL is the implicit default — not drawn). */
function failureEdgeLabel(
  onFailure: string,
  t: ReturnType<typeof useTranslations>,
): string | null {
  if (onFailure === WORKFLOW_STOP_FAIL) return null;
  if (onFailure === WORKFLOW_ESCALATE_TO_MANUAL)
    return t("edgeLabel.failureEscalate");
  return t("edgeLabel.failureGoto", { step: onFailure });
}

/** Label for a non-default success edge (NEXT is the implicit default — not drawn). */
function successEdgeLabel(
  onSuccess: string,
  nextKey: string | undefined,
  t: ReturnType<typeof useTranslations>,
): string | null {
  if (onSuccess === WORKFLOW_END_SUCCESS) return t("edgeLabel.successEnd");
  if (nextKey && onSuccess === nextKey) return null;
  return t("edgeLabel.successGoto", { step: onSuccess });
}
