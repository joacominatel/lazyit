"use client";

import {
  AI_INPUT_LIMITS,
  type AiInputAction,
  type AiInputAnswer,
  type AiInputField,
  type AiInputGroup,
  type AiInputOutcome,
  type AiInputSubmission,
} from "@lazyit/shared";
import {
  ChatBubbleLeftEllipsisIcon,
  ChevronRightIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useRef, useState, type ReactNode } from "react";
import { Combobox } from "@/components/combobox";
import { EntityMultiSelect } from "@/components/entity-multi-select";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Textarea } from "@/components/ui/textarea";
import {
  canAddRow,
  canRemoveRow,
  cellPath,
  checkDraft,
  displayAnswer,
  emptyRow,
  fieldPath,
  firstIssuePath,
  groupPath,
  hasNoOptions,
  initialDraft,
  localizeIssue,
  mapIssues,
  splitByImportance,
  type AnswerDisplay,
  type DraftValue,
  type InputDraft,
  type InputErrorKind,
  type IssueMap,
} from "@/lib/ai/input-form";
import type { InputPart } from "@/lib/ai/stream-reducer";
import { plainText } from "@/lib/ai/untrusted-text";
import type { InputResult } from "@/lib/api/hooks/use-ai-turn";
import { cn } from "@/lib/utils";

/** Multiselects with at most this many options render as a checkbox list; longer ones as a picker. */
const INLINE_CHOICES = 8;

/** The attribute the composer's "Go to the form" looks for. */
export const PENDING_INPUT_ATTR = "data-ai-input-pending";

export type InputStage = "pending" | "sending" | AiInputOutcome;

const STAGE_TONE: Record<InputStage, StatusTone> = {
  pending: "warning",
  sending: "info",
  submitted: "success",
  skipped: "neutral",
  declined: "neutral",
  expired: "neutral",
  cancelled: "neutral",
};

export type AnswerInput = (
  toolCallId: string,
  body: AiInputSubmission,
  answer?: AiInputAnswer,
) => Promise<InputResult>;

/** Moves focus to the first control inside the element marked with `path`. */
function focusPath(root: HTMLElement | null, path: string) {
  const holder = root?.querySelector<HTMLElement>(`[data-issue-path="${CSS.escape(path)}"]`);
  const target =
    holder?.querySelector<HTMLElement>("input, textarea, button, [tabindex]") ?? holder ?? null;
  target?.focus();
}

/** One answered value as plain escaped text. */
function AnswerValue({ value }: { value: AnswerDisplay }) {
  const t = useTranslations("ai.input");
  const format = useFormatter();
  switch (value.kind) {
    case "empty":
      return <span className="text-muted-foreground">{t("empty")}</span>;
    case "boolean":
      return <span>{value.value ? t("yes") : t("no")}</span>;
    case "number":
      return <span className="font-mono tabular-nums">{format.number(value.value)}</span>;
    case "date":
      return (
        <span className="font-mono tabular-nums">
          {format.dateTime(new Date(`${value.day}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })}
        </span>
      );
    case "list":
      return <span className="break-words">{value.items.map(plainText).join(", ")}</span>;
    case "text":
      return <span className="break-words whitespace-pre-wrap">{plainText(value.text)}</span>;
  }
}

function AnswerRows({
  fields,
  values,
}: {
  fields: readonly AiInputField[];
  values: AiInputAnswer["values"] | undefined;
}) {
  return (
    <dl className="divide-y divide-border">
      {fields.map((field) => (
        <div key={field.key} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 py-1.5">
          <dt className="text-xs text-muted-foreground">{plainText(field.label)}</dt>
          <dd className="min-w-0 text-xs">
            <AnswerValue value={displayAnswer(field, values?.[field.key])} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The read-only answer of a submitted form: every field, then each group's rows. */
function AnsweredForm({ part }: { part: InputPart }) {
  const t = useTranslations("ai.input");
  const { form } = part.request;
  const answer = part.answer;
  if (!answer) return <p className="text-xs text-muted-foreground">{t("answerSent")}</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">{t("yourAnswer")}</p>
      {form.fields.length > 0 && <AnswerRows fields={form.fields} values={answer.values} />}
      {form.groups.map((group) => {
        const rows = answer.groups[group.key] ?? [];
        return (
          <div key={group.key}>
            <p className="text-xs font-medium">{plainText(group.label)}</p>
            {rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noRows")}</p>
            ) : (
              <ol className="mt-1 space-y-1.5">
                {rows.map((row, index) => (
                  <li key={index} className="rounded-sm border border-border px-2">
                    <span className="sr-only">{t("row", { number: index + 1 })}</span>
                    <AnswerRows fields={group.fields} values={row} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ControlProps {
  field: AiInputField;
  id: string;
  value: DraftValue;
  invalid: boolean;
  describedBy?: string;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}

/** The editable control of one field kind. Every model-authored string is plain text. */
function FieldControl({ field, id, value, invalid, describedBy, disabled, onChange }: ControlProps) {
  const t = useTranslations("ai.input");
  const placeholder = field.placeholder ? plainText(field.placeholder) : undefined;
  const common = {
    id,
    disabled,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
    "aria-required": field.required || undefined,
  };
  const text = typeof value === "string" ? value : "";
  const options = (field.options ?? []).map((o) => ({ value: o.value, label: plainText(o.label) }));

  switch (field.kind) {
    case "textarea":
      return (
        <Textarea
          {...common}
          value={text}
          rows={3}
          maxLength={AI_INPUT_LIMITS.textareaLength}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <Input
          {...common}
          type="number"
          inputMode="decimal"
          step="any"
          min={field.min}
          max={field.max}
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "date":
      return <Input {...common} type="date" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "checkbox":
      return (
        <Checkbox
          {...common}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
      );
    case "select":
      return (
        <Combobox
          id={id}
          aria-invalid={invalid}
          disabled={disabled}
          value={text}
          items={options}
          placeholder={placeholder ?? t("choose")}
          searchPlaceholder={t("search")}
          emptyText={t("noMatch")}
          onValueChange={onChange}
        />
      );
    case "multiselect": {
      const selected = Array.isArray(value) ? value : [];
      if (options.length > INLINE_CHOICES) {
        return (
          <EntityMultiSelect
            label={plainText(field.label)}
            items={options}
            selected={selected}
            disabled={disabled}
            searchPlaceholder={t("search")}
            emptyText={t("noMatch")}
            onChange={onChange}
          />
        );
      }
      return (
        <ul
          id={id}
          role="group"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          className="space-y-1"
        >
          {options.map((option) => {
            const checked = selected.includes(option.value);
            const optionId = `${id}-${option.value}`;
            return (
              <li key={option.value} className="flex items-center gap-2">
                <Checkbox
                  id={optionId}
                  disabled={disabled}
                  checked={checked}
                  aria-invalid={invalid || undefined}
                  onCheckedChange={(next) =>
                    onChange(
                      next === true
                        ? [...selected, option.value]
                        : selected.filter((v) => v !== option.value),
                    )
                  }
                />
                <label htmlFor={optionId} className="min-h-7 flex-1 py-1 text-sm break-words">
                  {option.label}
                </label>
              </li>
            );
          })}
        </ul>
      );
    }
    default:
      return (
        <Input
          {...common}
          type="text"
          value={text}
          maxLength={AI_INPUT_LIMITS.textLength}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** A field: its label with the importance marker, its help, its control and its error. */
function InputField({
  field,
  path,
  value,
  error,
  disabled,
  onChange,
}: {
  field: AiInputField;
  path: string;
  value: DraftValue;
  error: ReactNode | null;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  const t = useTranslations("ai.input");
  const id = useId();
  const helpId = useId();
  const errorId = useId();
  const help = field.help ? plainText(field.help) : "";
  const noOptions = hasNoOptions(field);
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const isCheckbox = field.kind === "checkbox";
  const isList = field.kind === "multiselect" && (field.options ?? []).length <= INLINE_CHOICES;

  const label = (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="break-words">{plainText(field.label)}</span>
      {field.importance === "required" && (
        <>
          <span aria-hidden className="text-destructive-text">*</span>
          <span className="sr-only">({t("importance.required")})</span>
        </>
      )}
      {field.importance === "recommended" && (
        <StatusBadge tone="info">{t("importance.recommended")}</StatusBadge>
      )}
      {field.importance === "optional" && (
        <span className="text-xs font-normal text-muted-foreground">{t("importance.optional")}</span>
      )}
    </span>
  );

  return (
    <div data-issue-path={path} className="space-y-1">
      {isCheckbox ? (
        <div className="flex items-start gap-2">
          <FieldControl
            field={field}
            id={id}
            value={value}
            invalid={error !== null}
            describedBy={describedBy}
            disabled={disabled}
            onChange={onChange}
          />
          <label htmlFor={id} className="-mt-0.5 text-sm font-medium">
            {label}
          </label>
        </div>
      ) : (
        <>
          {isList ? (
            <p id={`${id}-label`} className="text-sm font-medium">
              {label}
            </p>
          ) : (
            <label htmlFor={id} className="block text-sm font-medium">
              {label}
            </label>
          )}
          {noOptions ? (
            <p className="text-xs text-muted-foreground">{t("noOptions")}</p>
          ) : (
            <FieldControl
              field={field}
              id={id}
              value={value}
              invalid={error !== null}
              describedBy={describedBy}
              disabled={disabled}
              onChange={onChange}
            />
          )}
        </>
      )}
      {field.optionsFrom && !noOptions && (
        <p className="text-xs text-muted-foreground">
          {t("optionsFrom", { source: t(`sources.${field.optionsFrom}`) })}
        </p>
      )}
      {help && (
        <p id={helpId} className="text-xs break-words whitespace-pre-wrap text-muted-foreground">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-destructive-text">
          {error}
        </p>
      )}
    </div>
  );
}

/** One repeat group: its rows (each a small card of the same columns), Add and Remove within bounds. */
function InputGroupRows({
  group,
  rows,
  issues,
  issueText,
  disabled,
  onChange,
}: {
  group: AiInputGroup;
  rows: InputDraft["groups"][string];
  issues: IssueMap;
  issueText: (message: string | undefined) => ReactNode | null;
  disabled: boolean;
  onChange: (rows: InputDraft["groups"][string]) => void;
}) {
  const t = useTranslations("ai.input");
  const legendId = useId();
  const groupError = issueText(issues[groupPath(group.key)]);
  const help = group.help ? plainText(group.help) : "";
  return (
    <fieldset
      data-issue-path={groupPath(group.key)}
      aria-labelledby={legendId}
      tabIndex={-1}
      className="space-y-2 rounded-sm border border-border p-2 outline-none"
    >
      <div>
        <p id={legendId} className="text-sm font-medium break-words">
          {plainText(group.label)}
        </p>
        <p className="text-xs text-muted-foreground">
          {group.minRows === group.maxRows
            ? t("rowsExactly", { count: group.minRows })
            : t("rowsBetween", { min: group.minRows, max: group.maxRows })}
        </p>
        {help && <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">{help}</p>}
      </div>
      <ol className="space-y-2">
        {rows.map((row, index) => (
          <li key={index} className="space-y-2 rounded-sm bg-muted/40 p-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">{t("row", { number: index + 1 })}</p>
              {canRemoveRow(group, rows.length) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={t("removeRow", { number: index + 1 })}
                  onClick={() => onChange(rows.filter((_, i) => i !== index))}
                >
                  <TrashIcon />
                </Button>
              )}
            </div>
            {group.fields.map((field) => {
              const path = cellPath(group.key, index, field.key);
              return (
                <InputField
                  key={field.key}
                  field={field}
                  path={path}
                  value={row[field.key] ?? ""}
                  error={issueText(issues[path])}
                  disabled={disabled}
                  onChange={(value) =>
                    onChange(rows.map((r, i) => (i === index ? { ...r, [field.key]: value } : r)))
                  }
                />
              );
            })}
          </li>
        ))}
      </ol>
      {canAddRow(group, rows.length) && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...rows, emptyRow(group.fields)])}
        >
          <PlusIcon />
          {t("addRow")}
        </Button>
      )}
      {groupError && <p className="text-xs text-destructive-text">{groupError}</p>}
    </fieldset>
  );
}

/**
 * The input form card (#1388; frontend.md K5b): a form the assistant built to ask for data it is missing.
 * Pending, it renders every field kind — required fields marked, recommended ones hinted, optional ones
 * behind "More details" — and repeat groups as rows; the answer is checked with the API's own
 * `checkAiInputAnswer` before it is sent, and a 400's issues land on the same fields. "Continue without"
 * skips it (the assistant goes on without the data); "Don't ask" declines it (the assistant is told not
 * to ask again). Resolved, it shows the outcome and, once submitted, the answer read-only.
 *
 * Nothing the model wrote is Markdown or HTML here: title, reason, labels, help, placeholders and options
 * are React text. The card is presented as the assistant's request, never as a lazyit prompt.
 */
export function AiInputCard({ part, onAnswer }: { part: InputPart; onAnswer: AnswerInput }) {
  const t = useTranslations("ai.input");
  const format = useFormatter();
  const titleId = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  const { request, outcome } = part;
  const { form } = request;

  const [draft, setDraft] = useState<InputDraft>(() => initialDraft(form));
  const [issues, setIssues] = useState<IssueMap>({});
  const [busy, setBusy] = useState<AiInputAction | null>(null);
  const [error, setError] = useState<InputErrorKind | null>(null);
  const [showOptional, setShowOptional] = useState(false);

  const pending = outcome === null;
  const stage: InputStage = pending ? (busy ? "sending" : "pending") : outcome;
  const { primary, optional } = splitByImportance(form.fields);
  const optionalHasIssue = optional.some((f) => issues[fieldPath(f.key)]);
  const optionalOpen = showOptional || optionalHasIssue;
  const hasRequired =
    form.fields.some((f) => f.required) || form.groups.some((g) => g.fields.some((f) => f.required));
  const expiresAt = new Date(request.expiresAt);

  function issueText(message: string | undefined): ReactNode | null {
    if (!message) return null;
    const known = localizeIssue(message);
    return known ? t(`issues.${known.key}`, known.values) : message;
  }

  function setValue(key: string, value: DraftValue) {
    setDraft((d) => ({ ...d, values: { ...d.values, [key]: value } }));
  }

  async function send(action: AiInputAction) {
    setError(null);
    let body: AiInputSubmission = { action };
    let answer: AiInputAnswer | undefined;
    let rowIndex: Record<string, number[]> = {};
    if (action === "submit") {
      const checked = checkDraft(form, draft);
      if (!checked.ok) {
        setIssues(checked.issues);
        const first = firstIssuePath(form, draft, checked.issues);
        if (first && optional.some((f) => fieldPath(f.key) === first)) setShowOptional(true);
        // Focus after the fields re-render with their errors.
        if (first) requestAnimationFrame(() => focusPath(rootRef.current, first));
        return;
      }
      body = checked.plan.body;
      answer = checked.answer;
      rowIndex = checked.plan.rowIndex;
    }
    setIssues({});
    setBusy(action);
    let result: InputResult;
    try {
      result = await onAnswer(request.toolCallId, body, answer);
    } finally {
      setBusy(null);
    }
    if (result.ok) return;
    setError(result.error);
    if (result.error.kind === "invalid") {
      const mapped = mapIssues(result.error.issues, rowIndex);
      setIssues(mapped);
      const first = firstIssuePath(form, draft, mapped);
      if (first) requestAnimationFrame(() => focusPath(rootRef.current, first));
    }
  }

  const fieldList = (fields: readonly AiInputField[]) =>
    fields.map((field) => (
      <InputField
        key={field.key}
        field={field}
        path={fieldPath(field.key)}
        value={draft.values[field.key] ?? ""}
        error={issueText(issues[fieldPath(field.key)])}
        disabled={busy !== null}
        onChange={(value) => setValue(field.key, value)}
      />
    ));

  return (
    <section
      ref={rootRef}
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      {...(pending ? { [PENDING_INPUT_ATTR]: "" } : {})}
      className="rounded-md border border-border border-l-4 border-l-primary/60 bg-card text-card-foreground outline-none"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
          <ChatBubbleLeftEllipsisIcon className="size-4 text-muted-foreground" aria-hidden />
          {t("kicker")}
        </p>
        <StatusBadge tone={STAGE_TONE[stage]}>{t(`states.${stage}`)}</StatusBadge>
      </header>

      <div className="space-y-3 px-3 py-3 text-sm">
        <div>
          <h3 id={titleId} className="font-medium break-words">
            {plainText(form.title)}
          </h3>
          <p className="mt-0.5 text-xs break-words whitespace-pre-wrap text-muted-foreground">
            {plainText(form.reason)}
          </p>
        </div>

        {pending ? (
          <form
            noValidate
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy === null) void send("submit");
            }}
          >
            {hasRequired && <p className="text-xs text-muted-foreground">{t("requiredLegend")}</p>}
            {fieldList(primary)}
            {form.groups.map((group) => (
              <InputGroupRows
                key={group.key}
                group={group}
                rows={draft.groups[group.key] ?? []}
                issues={issues}
                issueText={issueText}
                disabled={busy !== null}
                onChange={(rows) => setDraft((d) => ({ ...d, groups: { ...d.groups, [group.key]: rows } }))}
              />
            ))}
            {optional.length > 0 && (
              <div className="space-y-3">
                <button
                  type="button"
                  className="inline-flex min-h-8 items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground"
                  aria-expanded={optionalOpen}
                  onClick={() => setShowOptional((v) => !v)}
                >
                  <ChevronRightIcon
                    className={cn("size-3.5 transition-transform", optionalOpen && "rotate-90")}
                    aria-hidden
                  />
                  {optionalOpen ? t("lessDetails") : t("moreDetails", { count: optional.length })}
                </button>
                {optionalOpen && <div className="space-y-3">{fieldList(optional)}</div>}
              </div>
            )}

            {issues.form && <p className="text-xs text-destructive-text">{issueText(issues.form)}</p>}
            {error && (
              <div role="alert" className="text-xs text-destructive-text">
                <p>{t(`errors.${error.kind}`)}</p>
                {error.kind === "unknown" && <RequestIdNote requestId={error.requestId} className="mt-1" />}
              </div>
            )}
            {!error && Object.keys(issues).length > 0 && (
              <p role="alert" className="text-xs text-destructive-text">
                {t("errors.invalid")}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              {!Number.isNaN(expiresAt.getTime()) && (
                <p className="text-xs text-muted-foreground">
                  {t("expiresAt", { time: format.dateTime(expiresAt, { timeStyle: "short" }) })}
                </p>
              )}
              <div className="ml-auto flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  title={t("declineHint")}
                  onClick={() => void send("cancel")}
                >
                  {t("decline")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  title={t("skipHint")}
                  onClick={() => void send("skip")}
                >
                  {t("skip")}
                </Button>
                <Button type="submit" size="sm" disabled={busy !== null}>
                  {t("submit")}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("actionsHint")}</p>
          </form>
        ) : (
          <>
            {outcome === "submitted" && <AnsweredForm part={part} />}
            <p className="text-xs text-muted-foreground">{t(`notes.${outcome}`)}</p>
          </>
        )}
      </div>
    </section>
  );
}
