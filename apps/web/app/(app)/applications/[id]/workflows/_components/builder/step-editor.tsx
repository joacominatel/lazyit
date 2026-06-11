"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  type ManualInputField,
  WORKFLOW_HTTP_METHODS,
  WORKFLOW_RETRY_BACKOFF,
  type WorkflowHttpMethod,
  type WorkflowRetryBackoff,
  type WorkflowStep,
  WorkflowStepSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  applyFailureChoice,
  applySuccessChoice,
  buildSuccessCriteria,
  compensationKeyOf,
  type FailureChoice,
  failureChoiceOf,
  formatStatusCodes,
  gotoKeyOf,
  type SuccessChoice,
  successChoiceOf,
} from "@/lib/workflow/step-form";
import { DataMappingEditor } from "./data-mapping-editor";
import { PathField } from "./path-field";

const SUCCESS_CHOICES: SuccessChoice[] = ["NEXT", "END", "GOTO"];
const FAILURE_CHOICES: FailureChoice[] = [
  "STOP",
  "ESCALATE",
  "COMPENSATE",
  "CONTINUE",
];
const FIELD_TYPES: ManualInputField["type"][] = [
  "text",
  "number",
  "boolean",
  "select",
];

interface EditorState {
  name: string;
  method: WorkflowHttpMethod;
  path: string;
  idempotent: boolean;
  dataMapping: Record<string, string> | undefined;
  statusCodes: string;
  retryEnabled: boolean;
  maxAttempts: number;
  backoff: WorkflowRetryBackoff;
  delayMs: number;
  prompt: string;
  cohort: string;
  inputFields: ManualInputField[];
  successChoice: SuccessChoice;
  gotoKey: string;
  failureChoice: FailureChoice;
  compensateKey: string;
}

function initialState(step: WorkflowStep): EditorState {
  const isHttp = step.kind === "REST" || step.kind === "WEBHOOK_OUT";
  const retry = isHttp ? step.retry : undefined;
  return {
    name: step.name ?? "",
    method: step.kind === "REST" ? step.method : "POST",
    path: step.kind === "REST" ? step.path : "/",
    idempotent:
      step.kind === "REST" || step.kind === "WEBHOOK_OUT"
        ? step.idempotent
        : false,
    dataMapping: isHttp ? step.dataMapping : undefined,
    statusCodes: isHttp ? formatStatusCodes(step.successCriteria) : "",
    retryEnabled: (retry?.maxAttempts ?? 1) > 1,
    maxAttempts: retry?.maxAttempts ?? 2,
    backoff: retry?.backoff ?? "exponential",
    delayMs: retry?.delayMs ?? 1000,
    prompt: step.kind === "MANUAL" ? step.prompt : "",
    cohort: step.kind === "MANUAL" ? (step.cohort ?? "") : "",
    inputFields:
      step.kind === "MANUAL"
        ? step.inputFields
        : [{ name: "value", label: "Value", type: "text", required: true }],
    successChoice: successChoiceOf(step),
    gotoKey: gotoKeyOf(step) ?? "",
    failureChoice: failureChoiceOf(step),
    compensateKey: compensationKeyOf(step) ?? "",
  };
}

/**
 * The per-step configuration dialog (frontend.md §3c/§3d). A discriminated form body per kind
 * (REST/WEBHOOK_OUT/MANUAL) plus the universal opinionated controls: success criteria, retry policy, and
 * the "on failure →" closed set (stop / escalate / compensate / continue). On save it reconstructs the
 * shared `WorkflowStep`, validates it with the shared zod (early per-step feedback) and hands it back —
 * the whole-graph validation still happens server-side on version authoring.
 *
 * Layout (issues #301 + #341, ADR-0049): a roomy, near-full-screen dialog with a TAB rail
 * (General · Data · Retry · Flow) instead of one cramped, very-tall single column — so the operator
 * sees each facet of a step at a comfortable width without an awkward vertical scroll. The header and
 * the Apply/Cancel `DialogFooter` are pinned; only the active tab's body scrolls. `WorkflowStepSchema`
 * validation-on-save is unchanged.
 */
export function StepEditor({
  open,
  step,
  otherSteps,
  priorSteps,
  onSave,
  onClose,
}: {
  open: boolean;
  step: WorkflowStep;
  /** Other steps in the graph — the GOTO / COMPENSATE target options. */
  otherSteps: WorkflowStep[];
  /** Steps before this one — their outputs are in-scope value sources for the data mapping (#300). */
  priorSteps: WorkflowStep[];
  onSave: (step: WorkflowStep) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl lg:max-w-5xl">
        {open ? (
          <StepForm
            key={step.key}
            step={step}
            otherSteps={otherSteps}
            priorSteps={priorSteps}
            onSave={onSave}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StepForm({
  step,
  otherSteps,
  priorSteps,
  onSave,
  onClose,
}: {
  step: WorkflowStep;
  otherSteps: WorkflowStep[];
  priorSteps: WorkflowStep[];
  onSave: (step: WorkflowStep) => void;
  onClose: () => void;
}) {
  const t = useTranslations("workflow");
  const tc = useTranslations("common");
  const [values, setValues] = useState<EditorState>(() => initialState(step));
  const [error, setError] = useState<string | undefined>(undefined);

  function set<K extends keyof EditorState>(key: K, value: EditorState[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  const isHttp = step.kind === "REST" || step.kind === "WEBHOOK_OUT";

  function build(): WorkflowStep | null {
    const name = values.name.trim() || undefined;
    const success = applySuccessChoice(
      values.successChoice,
      values.gotoKey || undefined,
    );
    const failure = applyFailureChoice(
      values.failureChoice,
      values.compensateKey || undefined,
    );

    if (step.kind === "REST") {
      return {
        kind: "REST",
        key: step.key,
        connectionId: step.connectionId,
        name,
        method: values.method,
        path: values.path.trim(),
        idempotent: values.idempotent,
        dataMapping: values.dataMapping,
        successCriteria: buildSuccessCriteria(values.statusCodes),
        retry: values.retryEnabled
          ? {
              maxAttempts: values.maxAttempts,
              backoff: values.backoff,
              delayMs: values.delayMs,
            }
          : undefined,
        onSuccess: success.onSuccess,
        onFailure: failure.onFailure,
        onError: failure.onError ?? "fail",
      };
    }
    if (step.kind === "WEBHOOK_OUT") {
      return {
        kind: "WEBHOOK_OUT",
        key: step.key,
        connectionId: step.connectionId,
        name,
        idempotent: values.idempotent,
        dataMapping: values.dataMapping,
        successCriteria: buildSuccessCriteria(values.statusCodes),
        retry: values.retryEnabled
          ? {
              maxAttempts: values.maxAttempts,
              backoff: values.backoff,
              delayMs: values.delayMs,
            }
          : undefined,
        onSuccess: success.onSuccess,
        onFailure: failure.onFailure,
        onError: failure.onError ?? "fail",
      };
    }
    // MANUAL
    return {
      kind: "MANUAL",
      key: step.key,
      name,
      prompt: values.prompt.trim(),
      inputFields: values.inputFields,
      cohort: values.cohort.trim() || undefined,
      onSuccess: success.onSuccess,
      onFailure: failure.onFailure,
    };
  }

  function handleSave() {
    const built = build();
    if (!built) return;
    const parsed = WorkflowStepSchema.safeParse(built);
    if (!parsed.success) {
      setError(t("stepEditor.invalid"));
      return;
    }
    setError(undefined);
    onSave(parsed.data);
  }

  function addField() {
    set("inputFields", [
      ...values.inputFields,
      { name: "", label: "", type: "text", required: false },
    ]);
  }

  function editField(index: number, patch: Partial<ManualInputField>) {
    set(
      "inputFields",
      values.inputFields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    );
  }

  function removeField(index: number) {
    set(
      "inputFields",
      values.inputFields.filter((_, i) => i !== index),
    );
  }

  return (
    <>
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle>
          {t("stepEditor.title", { kind: t(`kind.${step.kind}`) })}
        </DialogTitle>
        <DialogDescription>{t("stepEditor.description")}</DialogDescription>
      </DialogHeader>

      <Tabs
        defaultValue="general"
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="shrink-0 gap-1 border-b px-5">
          <TabsTrigger value="general">{t("stepEditor.tab.general")}</TabsTrigger>
          {isHttp ? (
            <TabsTrigger value="data">{t("stepEditor.tab.data")}</TabsTrigger>
          ) : null}
          {isHttp ? (
            <TabsTrigger value="retry">{t("stepEditor.tab.retry")}</TabsTrigger>
          ) : null}
          <TabsTrigger value="flow">{t("stepEditor.tab.flow")}</TabsTrigger>
        </TabsList>

        {/* The active tab body scrolls; the header/footer stay pinned (issue #341). */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {/* ── General ─────────────────────────────────────────────── */}
          <TabsContent value="general" className="mt-0">
            <FieldSet>
              <Field>
                <FieldLabel htmlFor="step-name">
                  {t("stepEditor.nameLabel")}
                </FieldLabel>
                <Input
                  id="step-name"
                  value={values.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder={t("stepEditor.namePlaceholder")}
                  maxLength={200}
                />
              </Field>

              {step.kind === "REST" ? (
                <>
                  <Field className="w-40">
                    <FieldLabel htmlFor="step-method">
                      {t("stepEditor.methodLabel")}
                    </FieldLabel>
                    <Select
                      value={values.method}
                      onValueChange={(v) =>
                        set("method", v as WorkflowHttpMethod)
                      }
                    >
                      <SelectTrigger id="step-method">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WORKFLOW_HTTP_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="step-path">
                      {t("stepEditor.pathLabel")}
                    </FieldLabel>
                    <PathField
                      value={values.path}
                      onChange={(v) => set("path", v)}
                      priorSteps={priorSteps}
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="step-idempotent">
                        {t("stepEditor.idempotentLabel")}
                      </FieldLabel>
                      <FieldDescription>
                        {t("stepEditor.idempotentHint")}
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id="step-idempotent"
                      checked={values.idempotent}
                      onCheckedChange={(on) => set("idempotent", on)}
                    />
                  </Field>
                </>
              ) : null}

              {step.kind === "WEBHOOK_OUT" ? (
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="step-idempotent">
                      {t("stepEditor.idempotentLabel")}
                    </FieldLabel>
                    <FieldDescription>
                      {t("stepEditor.idempotentHint")}
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="step-idempotent"
                    checked={values.idempotent}
                    onCheckedChange={(on) => set("idempotent", on)}
                  />
                </Field>
              ) : null}

              {step.kind === "MANUAL" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="step-prompt">
                      {t("stepEditor.promptLabel")}
                    </FieldLabel>
                    <Textarea
                      id="step-prompt"
                      value={values.prompt}
                      onChange={(e) => set("prompt", e.target.value)}
                      placeholder={t("stepEditor.promptPlaceholder")}
                      rows={3}
                      maxLength={2000}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="step-cohort">
                      {t("stepEditor.cohortLabel")}
                    </FieldLabel>
                    <Input
                      id="step-cohort"
                      value={values.cohort}
                      onChange={(e) => set("cohort", e.target.value)}
                      placeholder={t("stepEditor.cohortPlaceholder")}
                      maxLength={100}
                    />
                  </Field>
                </>
              ) : null}
            </FieldSet>

            {/* ── Fields to fill (MANUAL) ──────────────────────────── */}
            {step.kind === "MANUAL" ? (
              <>
                <FieldSeparator className="my-6" />
                <FieldSet>
                  <FieldLegend variant="label">
                    {t("stepEditor.inputFieldsLabel")}
                  </FieldLegend>
                  <FieldDescription>
                    {t("stepEditor.inputFieldsHint")}
                  </FieldDescription>
                  <ul className="flex flex-col gap-3">
                    {values.inputFields.map((field, index) => (
                      <ManualFieldRow
                        key={`field-${index}`}
                        field={field}
                        onChange={(patch) => editField(index, patch)}
                        onRemove={() => removeField(index)}
                      />
                    ))}
                  </ul>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={addField}
                    className="w-fit"
                  >
                    <PlusIcon />
                    {t("stepEditor.addField")}
                  </Button>
                </FieldSet>
              </>
            ) : null}
          </TabsContent>

          {/* ── Data (HTTP: the data mapping — the roomy tab) ───────── */}
          {isHttp ? (
            <TabsContent value="data" className="mt-0">
              <FieldSet>
                <FieldLegend variant="label">
                  {t("stepEditor.mappingLabel")}
                </FieldLegend>
                <FieldDescription>
                  {t("stepEditor.mappingHint")}
                </FieldDescription>
                <DataMappingEditor
                  value={values.dataMapping}
                  onChange={(v) => set("dataMapping", v)}
                  priorSteps={priorSteps}
                />
              </FieldSet>
            </TabsContent>
          ) : null}

          {/* ── Retry (HTTP: success criteria + retry policy) ───────── */}
          {isHttp ? (
            <TabsContent value="retry" className="mt-0">
              <FieldSet>
                <FieldLegend variant="label">
                  {t("stepEditor.outcomeLabel")}
                </FieldLegend>
                <Field>
                  <FieldLabel htmlFor="step-status">
                    {t("stepEditor.successCriteriaLabel")}
                  </FieldLabel>
                  <Input
                    id="step-status"
                    value={values.statusCodes}
                    onChange={(e) => set("statusCodes", e.target.value)}
                    placeholder="200, 201, 204"
                    inputMode="numeric"
                  />
                  <FieldDescription>
                    {t("stepEditor.successCriteriaHint")}
                  </FieldDescription>
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="step-retry">
                      {t("stepEditor.retryLabel")}
                    </FieldLabel>
                    <FieldDescription>
                      {t("stepEditor.retryHint")}
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="step-retry"
                    checked={values.retryEnabled}
                    onCheckedChange={(on) => set("retryEnabled", on)}
                  />
                </Field>
                {values.retryEnabled ? (
                  <div className="flex flex-wrap gap-3 rounded-lg border bg-muted/30 p-3">
                    <Field className="w-24">
                      <FieldLabel htmlFor="step-attempts">
                        {t("stepEditor.maxAttemptsLabel")}
                      </FieldLabel>
                      <Input
                        id="step-attempts"
                        type="number"
                        min={1}
                        max={10}
                        value={values.maxAttempts}
                        onChange={(e) =>
                          set("maxAttempts", Number(e.target.value) || 1)
                        }
                      />
                    </Field>
                    <Field className="w-36">
                      <FieldLabel htmlFor="step-backoff">
                        {t("stepEditor.backoffLabel")}
                      </FieldLabel>
                      <Select
                        value={values.backoff}
                        onValueChange={(v) =>
                          set("backoff", v as WorkflowRetryBackoff)
                        }
                      >
                        <SelectTrigger id="step-backoff">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WORKFLOW_RETRY_BACKOFF.map((b) => (
                            <SelectItem key={b} value={b}>
                              {t(`backoff.${b}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field className="w-28">
                      <FieldLabel htmlFor="step-delay">
                        {t("stepEditor.delayLabel")}
                      </FieldLabel>
                      <Input
                        id="step-delay"
                        type="number"
                        min={0}
                        value={values.delayMs}
                        onChange={(e) =>
                          set("delayMs", Number(e.target.value) || 0)
                        }
                      />
                    </Field>
                  </div>
                ) : null}
              </FieldSet>
            </TabsContent>
          ) : null}

          {/* ── Flow (on success / on failure) ──────────────────────── */}
          <TabsContent value="flow" className="mt-0">
            <FieldSet>
              <FieldLegend variant="label">
                {t("stepEditor.flowLabel")}
              </FieldLegend>
              <Field>
                <FieldLabel htmlFor="step-onsuccess">
                  {t("stepEditor.onSuccessLabel")}
                </FieldLabel>
                <Select
                  value={values.successChoice}
                  onValueChange={(v) => set("successChoice", v as SuccessChoice)}
                >
                  <SelectTrigger id="step-onsuccess">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUCCESS_CHOICES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {t(`onSuccess.${c}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {values.successChoice === "GOTO" ? (
                  <StepKeySelect
                    value={values.gotoKey}
                    onChange={(v) => set("gotoKey", v)}
                    options={otherSteps}
                    placeholder={t("stepEditor.pickStep")}
                  />
                ) : null}
              </Field>

              <Field>
                <FieldLabel htmlFor="step-onfailure">
                  {t("stepEditor.onFailureLabel")}
                </FieldLabel>
                <Select
                  value={values.failureChoice}
                  onValueChange={(v) => set("failureChoice", v as FailureChoice)}
                >
                  <SelectTrigger id="step-onfailure">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FAILURE_CHOICES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {t(`onFailure.${c}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {t(`onFailureHint.${values.failureChoice}`)}
                </FieldDescription>
                {values.failureChoice === "COMPENSATE" ? (
                  <StepKeySelect
                    value={values.compensateKey}
                    onChange={(v) => set("compensateKey", v)}
                    options={otherSteps}
                    placeholder={t("stepEditor.pickStep")}
                  />
                ) : null}
              </Field>
            </FieldSet>
          </TabsContent>

        </div>
      </Tabs>

      {error ? (
        <div className="shrink-0 border-t px-5 py-2">
          <FieldError errors={[{ message: error }]} />
        </div>
      ) : null}

      <DialogFooter className="shrink-0 rounded-b-xl">
        <Button type="button" variant="outline" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button type="button" onClick={handleSave}>
          {t("stepEditor.apply")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * One manual input-field row (#299). A bordered card grouping the key/label/type/required controls; when
 * the type is `select` it reveals an inline OPTIONS editor so the admin defines the dropdown choices the
 * inbox renders. The options are the shared `ManualInputField.options` array.
 */
function ManualFieldRow({
  field,
  onChange,
  onRemove,
}: {
  field: ManualInputField;
  onChange: (patch: Partial<ManualInputField>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("workflow");
  return (
    <li className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={field.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t("stepEditor.fieldNamePlaceholder")}
          aria-label={t("stepEditor.fieldNameLabel")}
          className="w-28"
          maxLength={100}
        />
        <Input
          value={field.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder={t("stepEditor.fieldLabelPlaceholder")}
          aria-label={t("stepEditor.fieldLabelLabel")}
          className="w-32"
          maxLength={200}
        />
        <Select
          value={field.type}
          onValueChange={(v) =>
            onChange({ type: v as ManualInputField["type"] })
          }
        >
          <SelectTrigger className="w-28" aria-label={t("stepEditor.fieldTypeLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELD_TYPES.map((ft) => (
              <SelectItem key={ft} value={ft}>
                {t(`fieldType.${ft}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={field.required}
            onCheckedChange={(on) => onChange({ required: on })}
          />
          {t("stepEditor.fieldRequired")}
        </label>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={onRemove}
          aria-label={t("stepEditor.removeFieldAria")}
          className="ml-auto"
        >
          <XMarkIcon />
        </Button>
      </div>

      {field.type === "select" ? (
        <SelectOptionsEditor
          options={field.options ?? []}
          onChange={(options) =>
            onChange({ options: options.length > 0 ? options : undefined })
          }
        />
      ) : null}
    </li>
  );
}

/**
 * The select-field OPTIONS editor (#299) — add / remove / reorder the dropdown choices an admin defines
 * for a `select` manual input. Each option is a single string; the inbox renders these as the dropdown
 * the human picks from (alongside the static `suggestions`). The shared `ManualInputField.options` caps
 * the list at 50 entries / 200 chars each — mirrored here.
 */
function SelectOptionsEditor({
  options,
  onChange,
}: {
  options: string[];
  onChange: (options: string[]) => void;
}) {
  const t = useTranslations("workflow");

  function setOption(index: number, value: string) {
    onChange(options.map((o, i) => (i === index ? value : o)));
  }

  function addOption() {
    if (options.length >= 50) return;
    onChange([...options, ""]);
  }

  function removeOption(index: number) {
    onChange(options.filter((_, i) => i !== index));
  }

  function moveOption(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= options.length) return;
    const next = [...options];
    const [item] = next.splice(index, 1);
    if (item !== undefined) next.splice(target, 0, item);
    onChange(next);
  }

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <p className="text-xs font-medium text-muted-foreground">
        {t("stepEditor.optionsLabel")}
      </p>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("stepEditor.optionsEmpty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {options.map((option, index) => (
            <li key={`option-${index}`} className="flex items-center gap-1.5">
              <Input
                value={option}
                onChange={(e) => setOption(index, e.target.value)}
                placeholder={t("stepEditor.optionPlaceholder")}
                aria-label={t("stepEditor.optionAria", { index: index + 1 })}
                maxLength={200}
                className="h-8"
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={() => moveOption(index, -1)}
                disabled={index === 0}
                aria-label={t("stepEditor.optionMoveUpAria")}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={() => moveOption(index, 1)}
                disabled={index === options.length - 1}
                aria-label={t("stepEditor.optionMoveDownAria")}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={() => removeOption(index)}
                aria-label={t("stepEditor.optionRemoveAria")}
              >
                <XMarkIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={addOption}
        disabled={options.length >= 50}
        className="h-8"
      >
        <PlusIcon />
        {t("stepEditor.addOption")}
      </Button>
    </div>
  );
}

/** A select over other steps' keys (their `name` when set, else the key) — for GOTO / COMPENSATE. */
function StepKeySelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: WorkflowStep[];
  placeholder: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="mt-2">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((s) => (
          <SelectItem key={s.key} value={s.key}>
            {s.name ? `${s.name} (${s.key})` : s.key}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
