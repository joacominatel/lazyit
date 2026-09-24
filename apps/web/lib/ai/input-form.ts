import {
  AI_INPUT_LIMITS,
  checkAiInputAnswer,
  type AiInputAnswer,
  type AiInputField,
  type AiInputForm,
  type AiInputGroup,
  type AiInputIssue,
  type AiInputSubmission,
  type AiInputValue,
} from "@lazyit/shared";
import { refusalOf } from "./error-kinds";

/**
 * The input form the assistant builds (#1388; frontend.md K5b) — the pure half: the editable draft, its
 * mapping to the submission body, the issue paths mapped back to the fields, the refusals mapped to what
 * the card says, and the answered values mapped to what the read-only card shows. React-free and
 * `bun test`ed; the card (`components/ai/ai-input-card.tsx`) only renders it.
 *
 * Every string of a form is model-authored (or lazyit data resolved server-side): it is rendered as plain
 * React text, never Markdown or HTML.
 */

/** What an editable control holds: text-like kinds a string, a checkbox a boolean, a multiselect ids. */
export type DraftValue = string | boolean | string[];
export type DraftRow = Record<string, DraftValue>;

export interface InputDraft {
  values: DraftRow;
  groups: Record<string, DraftRow[]>;
}

function emptyValue(field: AiInputField): DraftValue {
  if (field.kind === "checkbox") return false;
  if (field.kind === "multiselect") return [];
  return "";
}

export function emptyRow(fields: readonly AiInputField[]): DraftRow {
  const row: DraftRow = {};
  for (const field of fields) row[field.key] = emptyValue(field);
  return row;
}

/** The rows a group starts with: its minimum, and at least one so the user sees the columns. */
export function initialRowCount(group: AiInputGroup): number {
  return Math.min(Math.max(group.minRows, 1), group.maxRows);
}

export function initialDraft(form: AiInputForm): InputDraft {
  const groups: Record<string, DraftRow[]> = {};
  for (const group of form.groups) {
    groups[group.key] = Array.from({ length: initialRowCount(group) }, () => emptyRow(group.fields));
  }
  return { values: emptyRow(form.fields), groups };
}

export function canAddRow(group: AiInputGroup, rows: number): boolean {
  return rows < Math.min(group.maxRows, AI_INPUT_LIMITS.rows);
}

export function canRemoveRow(group: AiInputGroup, rows: number): boolean {
  return rows > group.minRows;
}

function isBlankDraft(value: DraftValue | undefined): boolean {
  if (value === undefined || value === false) return true;
  if (typeof value === "string") return value.trim() === "";
  return Array.isArray(value) && value.length === 0;
}

/** A row the user left untouched: every value blank (a checkbox unticked). */
export function isBlankRow(row: DraftRow): boolean {
  return Object.values(row).every(isBlankDraft);
}

/** One draft value → the wire value, or `undefined` to leave the key out (a blank). */
function wireValue(field: AiInputField, value: DraftValue | undefined): AiInputValue | undefined {
  switch (field.kind) {
    case "checkbox":
      return value === true;
    case "multiselect":
      return Array.isArray(value) && value.length > 0 ? value : undefined;
    case "number": {
      if (typeof value !== "string" || value.trim() === "") return undefined;
      const n = Number(value.trim());
      // An unparsable entry is sent as typed, so the check reports it on its field.
      return Number.isFinite(n) ? n : value;
    }
    default:
      return typeof value === "string" && value.trim() !== "" ? value : undefined;
  }
}

function wireRow(fields: readonly AiInputField[], row: DraftRow): Record<string, AiInputValue> {
  const out: Record<string, AiInputValue> = {};
  for (const field of fields) {
    const value = wireValue(field, row[field.key]);
    if (value !== undefined) out[field.key] = value;
  }
  return out;
}

export interface SubmissionPlan {
  /** The `POST …/input` body for `submit`. */
  body: AiInputSubmission & { action: "submit" };
  /** Per group: the draft row index of each submitted row (untouched extra rows are left out). */
  rowIndex: Record<string, number[]>;
}

/**
 * The draft → the submit body. Blank values are left out; a group's untouched rows are left out as long
 * as the rows that remain still reach its minimum (otherwise every row is sent, so the required fields
 * of the empty ones are reported where the user sees them).
 */
export function toSubmission(form: AiInputForm, draft: InputDraft): SubmissionPlan {
  const values = wireRow(form.fields, draft.values);
  const groups: Record<string, Record<string, AiInputValue>[]> = {};
  const rowIndex: Record<string, number[]> = {};
  for (const group of form.groups) {
    const rows = draft.groups[group.key] ?? [];
    let kept = rows.map((row, index) => ({ row, index })).filter(({ row }) => !isBlankRow(row));
    if (kept.length < group.minRows) kept = rows.map((row, index) => ({ row, index }));
    groups[group.key] = kept.map(({ row }) => wireRow(group.fields, row));
    rowIndex[group.key] = kept.map(({ index }) => index);
  }
  return { body: { action: "submit", values, groups }, rowIndex };
}

/** Field errors keyed by draft path: `values.<key>`, `groups.<key>`, `groups.<key>.<row>.<key>`; `form` for the rest. */
export type IssueMap = Record<string, string>;

export function fieldPath(key: string): string {
  return `values.${key}`;
}

export function cellPath(group: string, row: number, key: string): string {
  return `groups.${group}.${row}.${key}`;
}

export function groupPath(group: string): string {
  return `groups.${group}`;
}

/**
 * Issue paths (of the submitted body) → draft paths, first message per path. A row index is translated
 * back to the draft row it came from; a path the form does not have lands on `form`.
 */
export function mapIssues(issues: readonly AiInputIssue[], rowIndex: Record<string, number[]>): IssueMap {
  const out: IssueMap = {};
  const put = (path: string, message: string) => {
    if (!(path in out)) out[path] = message;
  };
  for (const issue of issues) {
    const parts = issue.path.split(".");
    if (parts[0] === "values" && parts.length === 2) {
      put(issue.path, issue.message);
    } else if (parts[0] === "groups" && parts.length === 2) {
      put(issue.path, issue.message);
    } else if (parts[0] === "groups" && parts.length === 4 && /^\d+$/.test(parts[2]!)) {
      const sent = Number(parts[2]);
      const row = rowIndex[parts[1]!]?.[sent] ?? sent;
      put(cellPath(parts[1]!, row, parts[3]!), issue.message);
    } else {
      put("form", issue.message);
    }
  }
  return out;
}

/** The client-side check — the API's own — on the body about to be sent. */
export function checkDraft(
  form: AiInputForm,
  draft: InputDraft,
): { ok: true; plan: SubmissionPlan; answer: AiInputAnswer } | { ok: false; issues: IssueMap } {
  const plan = toSubmission(form, draft);
  const checked = checkAiInputAnswer(form, plan.body);
  if (!checked.ok) return { ok: false, issues: mapIssues(checked.issues, plan.rowIndex) };
  return { ok: true, plan, answer: checked.answer };
}

/** The draft path of the first issue in form order, to move focus there. */
export function firstIssuePath(form: AiInputForm, draft: InputDraft, issues: IssueMap): string | null {
  for (const field of form.fields) if (issues[fieldPath(field.key)]) return fieldPath(field.key);
  for (const group of form.groups) {
    if (issues[groupPath(group.key)]) return groupPath(group.key);
    const rows = draft.groups[group.key] ?? [];
    for (let row = 0; row < rows.length; row++) {
      for (const field of group.fields) {
        if (issues[cellPath(group.key, row, field.key)]) return cellPath(group.key, row, field.key);
      }
    }
  }
  return issues.form ? "form" : null;
}

/** The fields shown up front; `optional` ones sit behind "More details" unless they have an error. */
export function splitByImportance(fields: readonly AiInputField[]): {
  primary: AiInputField[];
  optional: AiInputField[];
} {
  return {
    primary: fields.filter((f) => f.importance !== "optional"),
    optional: fields.filter((f) => f.importance === "optional"),
  };
}

/** Whether the field's options are missing: a select lazyit could not fill (it asks for text then). */
export function hasNoOptions(field: AiInputField): boolean {
  return (field.kind === "select" || field.kind === "multiselect") && (field.options ?? []).length === 0;
}

/* ── Refusals of `POST /ai/runs/:id/tool-calls/:toolCallId/input` ─────────────────────────────── */

export type InputErrorKind =
  /** 400 INVALID_INPUT: the answer does not fit the stored form; `issues` point at the fields. */
  | { kind: "invalid"; issues: AiInputIssue[] }
  /** 409 RUN_NOT_AWAITING_INPUT: already answered (another tab) or the run no longer waits. */
  | { kind: "notAwaiting" }
  /** 409 EXPIRED: the form's time ran out and the run ended. */
  | { kind: "expired" }
  | { kind: "aiDisabled" }
  | { kind: "forbidden" }
  | { kind: "notFound" }
  | { kind: "unknown"; requestId?: string };

/** Every kind has a message key `ai.input.errors.<kind>` (covering set). */
export const INPUT_ERROR_KINDS = [
  "invalid",
  "notAwaiting",
  "expired",
  "aiDisabled",
  "forbidden",
  "notFound",
  "unknown",
] as const satisfies readonly InputErrorKind["kind"][];

function issuesOf(body: unknown): AiInputIssue[] {
  const raw = (body as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const i = item as { path?: unknown; message?: unknown };
    return typeof i?.path === "string" && typeof i.message === "string"
      ? [{ path: i.path, message: i.message }]
      : [];
  });
}

export function inputErrorKind(error: unknown): InputErrorKind {
  const refusal = refusalOf(error);
  if (!refusal) return { kind: "unknown" };
  const { status, code } = refusal;
  if (status === 400 && code === "INVALID_INPUT") {
    return { kind: "invalid", issues: issuesOf((error as { body?: unknown }).body) };
  }
  if (status === 409) {
    if (code === "EXPIRED") return { kind: "expired" };
    if (code === "AI_DISABLED") return { kind: "aiDisabled" };
    return { kind: "notAwaiting" };
  }
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "notFound" };
  return { kind: "unknown", requestId: refusal.requestId };
}

/** Kinds after which the card is re-read from the server (a fresh `run.snapshot`). */
export function inputNeedsRefresh(kind: InputErrorKind): boolean {
  return kind.kind === "notAwaiting" || kind.kind === "expired";
}

/* ── The answered, read-only card ─────────────────────────────────────────────────────────────── */

export type AnswerDisplay =
  | { kind: "empty" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  /** A `YYYY-MM-DD` day. */
  | { kind: "date"; day: string }
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[] };

function optionLabel(field: AiInputField, value: string): string {
  return field.options?.find((option) => option.value === value)?.label ?? value;
}

/** One answered value as the read-only card shows it: an option by its label, never its raw id. */
export function displayAnswer(field: AiInputField, value: AiInputValue | undefined): AnswerDisplay {
  if (value === undefined || value === null) return { kind: "empty" };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (Array.isArray(value)) {
    return value.length === 0 ? { kind: "empty" } : { kind: "list", items: value.map((v) => optionLabel(field, v)) };
  }
  if (typeof value === "number") return { kind: "number", value };
  if (value.trim() === "") return { kind: "empty" };
  if (field.kind === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: "date", day: value };
  return { kind: "text", text: field.kind === "select" ? optionLabel(field, value) : value };
}

/* ── Issue messages ───────────────────────────────────────────────────────────────────────────── */

/** A localizable issue: a key under `ai.input.issues` and its values. */
export interface IssueText {
  key: "required" | "maxChars" | "min" | "max" | "notOffered" | "invalid" | "rows" | "unknown";
  values?: Record<string, string | number>;
}

/**
 * The shared check's (English) issue messages → a message key, so the card speaks the user's language.
 * A message this build does not recognize (a newer API's) returns null and is shown as sent.
 */
export function localizeIssue(message: string): IssueText | null {
  if (message === "This field is required") return { key: "required" };
  if (message === "Not one of the offered options") return { key: "notOffered" };
  if (message === "Unknown field" || message === "Unknown group") return { key: "unknown" };
  let m = /^At most (\d+) characters$/.exec(message);
  if (m) return { key: "maxChars", values: { max: Number(m[1]) } };
  m = /^At least (\S+)$/.exec(message);
  if (m) return { key: "min", values: { min: m[1]! } };
  m = /^At most (\S+)$/.exec(message);
  if (m) return { key: "max", values: { max: m[1]! } };
  m = /^Between (\d+) and (\d+) rows$/.exec(message);
  if (m) return { key: "rows", values: { min: Number(m[1]), max: Number(m[2]) } };
  if (/^Not a valid \w+ value$/.test(message)) return { key: "invalid" };
  return null;
}
