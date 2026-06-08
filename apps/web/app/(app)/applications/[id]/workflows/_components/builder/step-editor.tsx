"use client";

import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
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
    idempotent: step.kind === "REST" ? step.idempotent : false,
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
 */
export function StepEditor({
  open,
  step,
  otherSteps,
  onSave,
  onClose,
}: {
  open: boolean;
  step: WorkflowStep;
  /** Other steps in the graph — the GOTO / COMPENSATE target options. */
  otherSteps: WorkflowStep[];
  onSave: (step: WorkflowStep) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {open ? (
          <StepForm
            key={step.key}
            step={step}
            otherSteps={otherSteps}
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
  onSave,
  onClose,
}: {
  step: WorkflowStep;
  otherSteps: WorkflowStep[];
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
      <DialogHeader>
        <DialogTitle>
          {t("stepEditor.title", { kind: t(`kind.${step.kind}`) })}
        </DialogTitle>
        <DialogDescription>{t("stepEditor.description")}</DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="step-name">{t("stepEditor.nameLabel")}</FieldLabel>
          <Input
            id="step-name"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={t("stepEditor.namePlaceholder")}
            maxLength={200}
          />
        </Field>

        {step.kind === "REST" ? (
          <div className="flex gap-2">
            <Field className="w-32 shrink-0">
              <FieldLabel htmlFor="step-method">
                {t("stepEditor.methodLabel")}
              </FieldLabel>
              <Select
                value={values.method}
                onValueChange={(v) => set("method", v as WorkflowHttpMethod)}
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
            <Field className="flex-1">
              <FieldLabel htmlFor="step-path">
                {t("stepEditor.pathLabel")}
              </FieldLabel>
              <Input
                id="step-path"
                value={values.path}
                onChange={(e) => set("path", e.target.value)}
                placeholder="/rest/api/3/user"
                className="font-mono text-xs"
                maxLength={2048}
              />
            </Field>
          </div>
        ) : null}

        {step.kind === "REST" ? (
          <Field orientation="horizontal">
            <div className="space-y-0.5">
              <FieldLabel htmlFor="step-idempotent">
                {t("stepEditor.idempotentLabel")}
              </FieldLabel>
              <FieldDescription>
                {t("stepEditor.idempotentHint")}
              </FieldDescription>
            </div>
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
                rows={2}
                maxLength={2000}
              />
            </Field>
            <Field>
              <FieldLabel>{t("stepEditor.inputFieldsLabel")}</FieldLabel>
              <FieldDescription>
                {t("stepEditor.inputFieldsHint")}
              </FieldDescription>
              <ul className="space-y-2">
                {values.inputFields.map((field, index) => (
                  <li
                    key={`field-${index}`}
                    className="flex flex-wrap items-center gap-2 rounded-md border p-2"
                  >
                    <Input
                      value={field.name}
                      onChange={(e) =>
                        editField(index, { name: e.target.value })
                      }
                      placeholder={t("stepEditor.fieldNamePlaceholder")}
                      aria-label={t("stepEditor.fieldNameLabel")}
                      className="w-28"
                      maxLength={100}
                    />
                    <Input
                      value={field.label}
                      onChange={(e) =>
                        editField(index, { label: e.target.value })
                      }
                      placeholder={t("stepEditor.fieldLabelPlaceholder")}
                      aria-label={t("stepEditor.fieldLabelLabel")}
                      className="w-32"
                      maxLength={200}
                    />
                    <Select
                      value={field.type}
                      onValueChange={(v) =>
                        editField(index, {
                          type: v as ManualInputField["type"],
                        })
                      }
                    >
                      <SelectTrigger className="w-28">
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
                        onCheckedChange={(on) =>
                          editField(index, { required: on })
                        }
                      />
                      {t("stepEditor.fieldRequired")}
                    </label>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => removeField(index)}
                      aria-label={t("stepEditor.removeFieldAria")}
                    >
                      <XMarkIcon />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addField}
                className="mt-2"
              >
                <PlusIcon />
                {t("stepEditor.addField")}
              </Button>
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

        {isHttp ? (
          <>
            <Field>
              <FieldLabel>{t("stepEditor.mappingLabel")}</FieldLabel>
              <FieldDescription>{t("stepEditor.mappingHint")}</FieldDescription>
              <DataMappingEditor
                value={values.dataMapping}
                onChange={(v) => set("dataMapping", v)}
              />
            </Field>
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
              <div className="space-y-0.5">
                <FieldLabel htmlFor="step-retry">
                  {t("stepEditor.retryLabel")}
                </FieldLabel>
                <FieldDescription>{t("stepEditor.retryHint")}</FieldDescription>
              </div>
              <Switch
                id="step-retry"
                checked={values.retryEnabled}
                onCheckedChange={(on) => set("retryEnabled", on)}
              />
            </Field>
            {values.retryEnabled ? (
              <div className="flex flex-wrap gap-2">
                <Field className="w-28">
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
                    onChange={(e) => set("delayMs", Number(e.target.value) || 0)}
                  />
                </Field>
              </div>
            ) : null}
          </>
        ) : null}

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

        {error ? <FieldError errors={[{ message: error }]} /> : null}
      </FieldGroup>

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button type="button" onClick={handleSave}>
          {t("stepEditor.apply")}
        </Button>
      </div>
    </>
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
