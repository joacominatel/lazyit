"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { ManualInputField } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DetailField, DetailPanel } from "@/components/detail-panel";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
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
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ManualTaskDetail } from "@/lib/api/endpoints/workflow-tasks";
import { notifyError } from "@/lib/api/notify-error";
import {
  useFailWorkflowTask,
  useSkipWorkflowTask,
  useSubmitWorkflowTask,
} from "@/lib/api/hooks/use-workflow-tasks";
import { useCan } from "@/lib/hooks/use-permissions";

/** Seed the input record from the field defaults (booleans false, others empty). */
function initialInput(fields: ManualInputField[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const field of fields) {
    record[field.name] = field.type === "boolean" ? false : "";
  }
  return record;
}

/**
 * The task action UI (frontend.md §6b) — the focused form for resolving one manual task. Shows the
 * context (the originating step + whether it is a manual step or an escalated failure), the typed
 * `inputFields` the human fills (with STATIC admin-typed suggestions as datalist hints — never a
 * directory lookup), and the Submit / Skip / Fail actions. All actions are gated on `workflow:task`
 * (the API enforces the assignee/cohort match). Every untrusted value (the prompt, suggestions) is
 * rendered as escaped text ONLY (SEC-A5).
 */
export function TaskAction({ task }: { task: ManualTaskDetail }) {
  const t = useTranslations("workflow");
  const router = useRouter();
  const canAct = useCan("workflow:task");

  const submit = useSubmitWorkflowTask();
  const skip = useSkipWorkflowTask();
  const fail = useFailWorkflowTask();
  const isPending = submit.isPending || skip.isPending || fail.isPending;

  const [input, setInput] = useState<Record<string, unknown>>(() =>
    initialInput(task.inputFields),
  );
  const [reason, setReason] = useState("");

  const isResolved = task.status !== "PENDING";

  function setField(name: string, value: unknown) {
    setInput((prev) => ({ ...prev, [name]: value }));
  }

  function backToInbox() {
    router.push("/settings/integrations/tasks");
  }

  function onSubmit() {
    submit.mutate(
      { id: task.id, input },
      {
        onSuccess: () => {
          toast.success(t("taskAction.toastSubmitted"));
          backToInbox();
        },
        onError: (err) => notifyError(err, t("taskAction.toastError")),
      },
    );
  }

  function onSkip() {
    skip.mutate(task.id, {
      onSuccess: () => {
        toast.success(t("taskAction.toastSkipped"));
        backToInbox();
      },
      onError: (err) => notifyError(err, t("taskAction.toastError")),
    });
  }

  function onFail() {
    fail.mutate(
      { id: task.id, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(t("taskAction.toastFailed"));
          backToInbox();
        },
        onError: (err) => notifyError(err, t("taskAction.toastError")),
      },
    );
  }

  return (
    <div className="space-y-6">
      <DetailPanel title={t("taskAction.contextTitle")}>
        <div className="space-y-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <DetailField label={t("taskAction.originLabel")}>
              <StatusBadge
                tone={task.origin === "ESCALATED_FAILURE" ? "danger" : "info"}
              >
                {t(`inbox.origin.${task.origin}`)}
              </StatusBadge>
            </DetailField>
            <DetailField label={t("taskAction.stepLabel")}>
              {task.stepKey}
            </DetailField>
          </dl>
          {/* SEC-A5: untrusted prompt rendered as escaped text only. */}
          <p className="text-sm whitespace-pre-wrap break-words">
            {task.prompt}
          </p>
        </div>
      </DetailPanel>

      {isResolved ? (
        <DetailPanel title={t("taskAction.resolvedTitle")}>
          <p className="text-sm text-muted-foreground">
            {t(`taskAction.resolvedStatus.${task.status}`)}
          </p>
        </DetailPanel>
      ) : (
        <DetailPanel title={t("taskAction.formTitle")}>
          <div className="space-y-4">
            {task.inputFields.map((field) => (
              <TaskInputField
                key={field.name}
                field={field}
                value={input[field.name]}
                onChange={(v) => setField(field.name, v)}
                disabled={!canAct || isPending}
              />
            ))}

            <Field>
              <FieldLabel htmlFor="task-fail-reason">
                {t("taskAction.failReasonLabel")}
              </FieldLabel>
              <Textarea
                id="task-fail-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("taskAction.failReasonPlaceholder")}
                rows={2}
                maxLength={500}
                disabled={!canAct || isPending}
              />
              <FieldDescription>
                {t("taskAction.failReasonHint")}
              </FieldDescription>
            </Field>

            {canAct ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={onFail}
                  disabled={isPending}
                >
                  {t("taskAction.fail")}
                </Button>
                <Button
                  variant="outline"
                  onClick={onSkip}
                  disabled={isPending}
                >
                  {t("taskAction.skip")}
                </Button>
                <Button onClick={onSubmit} disabled={isPending}>
                  {isPending && <ArrowPathIcon className="animate-spin" />}
                  {t("taskAction.submit")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("taskAction.noPermission")}
              </p>
            )}
          </div>
        </DetailPanel>
      )}
    </div>
  );
}

function TaskInputField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: ManualInputField;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  const t = useTranslations("workflow");
  const listId = `task-suggestions-${field.name}`;
  const hasSuggestions = (field.suggestions?.length ?? 0) > 0;
  // A select renders the admin-defined `options` first, then the static `suggestions` as extra choices
  // (deduped, order-preserving). With NO choices at all it would be a dead empty dropdown, so we fall
  // back to a free-text input (the same control the other text types use) rather than an unusable select.
  const selectChoices =
    field.type === "select"
      ? [...new Set([...(field.options ?? []), ...(field.suggestions ?? [])])]
      : [];

  return (
    <Field orientation={field.type === "boolean" ? "horizontal" : "vertical"}>
      <FieldLabel htmlFor={`task-field-${field.name}`}>
        {/* SEC-A5: admin-typed label rendered as escaped text. */}
        {field.label}
        {field.required ? " *" : ""}
      </FieldLabel>
      {field.type === "boolean" ? (
        <Switch
          id={`task-field-${field.name}`}
          checked={value === true}
          onCheckedChange={onChange}
          disabled={disabled}
        />
      ) : field.type === "select" && selectChoices.length > 0 ? (
        <Select
          value={typeof value === "string" && value ? value : undefined}
          onValueChange={onChange}
          disabled={disabled}
        >
          <SelectTrigger id={`task-field-${field.name}`}>
            <SelectValue placeholder={t("taskAction.selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {selectChoices.map((option) => (
              <SelectItem key={option} value={option}>
                {/* SEC-A5: admin-typed option rendered as escaped text. */}
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <>
          <Input
            id={`task-field-${field.name}`}
            type={field.type === "number" ? "number" : "text"}
            value={typeof value === "string" ? value : String(value ?? "")}
            onChange={(e) =>
              onChange(
                field.type === "number"
                  ? e.target.value === ""
                    ? ""
                    : Number(e.target.value)
                  : e.target.value,
              )
            }
            disabled={disabled}
            list={hasSuggestions ? listId : undefined}
            maxLength={2000}
          />
          {hasSuggestions ? (
            <datalist id={listId}>
              {field.suggestions?.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          ) : null}
        </>
      )}
    </Field>
  );
}
