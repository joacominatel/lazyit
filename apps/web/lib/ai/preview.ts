import type { AiActionPreview, AiPreviewValueKind } from "@lazyit/shared";
import { stripUntrusted } from "./untrusted-text";

/**
 * The approval card's pure presenter (frontend.md §5.3; tools-and-execution.md §9). The card is drawn ONLY
 * from the server-built preview, never from model prose. Every value is reduced to plain text here; the
 * component renders it as React text (escaped), never as HTML.
 */

/** A rendered value. */
export type PreviewValue =
  | { kind: "empty" }
  | { kind: "text"; text: string; untrusted: boolean }
  | { kind: "number"; value: number }
  | { kind: "date"; iso: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "redacted" };

export type PreviewRecord = Record<string, unknown>;

export interface PreviewRow {
  field: string;
  before: PreviewValue | null;
  after: PreviewValue;
  /**
   * Set when `after` is an array of objects (a batch's rows, #1387): the raw records, which the card
   * renders as a table (`preview-table.ts`) instead of the flat `after` text.
   */
  records?: PreviewRecord[];
}

export interface PreviewModel {
  /** The plain-language sentence of the `action` row, shown first. */
  action: { text: string; untrusted: boolean } | null;
  rows: PreviewRow[];
  /** Flags the card states as a notice rather than a field row (see {@link PREVIEW_NOTICE_FIELDS}). */
  notices: PreviewNotice[];
}

/**
 * Boolean preview fields that, when `true`, are a sentence on the card instead of a "Yes" row:
 * `duplicatesUnchecked` — a batch whose duplicate pre-check could not run for every value (#1387).
 */
export const PREVIEW_NOTICE_FIELDS = ["duplicatesUnchecked"] as const;
export type PreviewNotice = (typeof PREVIEW_NOTICE_FIELDS)[number];

function isNoticeField(field: string): field is PreviewNotice {
  return (PREVIEW_NOTICE_FIELDS as readonly string[]).includes(field);
}

const MAX_TEXT = 500;

function textValue(raw: string): PreviewValue {
  const { text, untrusted } = stripUntrusted(raw);
  const trimmed = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  return trimmed.trim() === "" ? { kind: "empty" } : { kind: "text", text: trimmed, untrusted };
}

/** An entity-ish object → its label, else its name/title/id. */
function labelOf(value: Record<string, unknown>): string | null {
  for (const key of ["label", "name", "title", "displayName", "email", "slug", "id"]) {
    const v = value[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

export function formatPreviewValue(value: unknown, kind?: AiPreviewValueKind): PreviewValue {
  if (kind === "redacted") return { kind: "redacted" };
  if (value === undefined || value === null || value === "") return { kind: "empty" };

  if (kind === "date" && typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return { kind: "date", iso: value };
  }
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", value };
  if (typeof value === "string") return textValue(value);
  if (Array.isArray(value)) {
    const items = value
      .map((item) => {
        const formatted = formatPreviewValue(item);
        return formatted.kind === "text" ? formatted.text : formatted.kind === "number" ? String(formatted.value) : null;
      })
      .filter((item): item is string => item !== null);
    return items.length === 0 ? { kind: "empty" } : textValue(items.join(", "));
  }
  if (typeof value === "object") {
    const label = labelOf(value as Record<string, unknown>);
    if (label !== null) return textValue(label);
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      return { kind: "empty" };
    }
    return textValue(json);
  }
  return textValue(String(value));
}

/** True when a preview value is a non-empty array whose every item is a (non-array) object. */
export function isRecordArray(value: unknown): value is PreviewRecord[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))
  );
}

/** Splits the preview into its `action` sentence (the first row by convention) and the field rows. */
export function presentPreview(preview: Pick<AiActionPreview, "changes">): PreviewModel {
  let action: PreviewModel["action"] = null;
  const rows: PreviewRow[] = [];
  const notices: PreviewNotice[] = [];
  for (const change of preview.changes) {
    if (isNoticeField(change.field) && typeof change.after === "boolean") {
      if (change.after && !notices.includes(change.field)) notices.push(change.field);
      continue;
    }
    if (change.field === "action" && action === null && typeof change.after === "string") {
      const clean = stripUntrusted(change.after);
      action = { text: clean.text, untrusted: clean.untrusted };
      continue;
    }
    rows.push({
      field: change.field,
      before:
        change.before === undefined ? null : formatPreviewValue(change.before, change.valueKind),
      after: formatPreviewValue(change.after, change.valueKind),
      // A redacted value never reaches the table: its records are dropped with it.
      ...(change.valueKind !== "redacted" && isRecordArray(change.after) ? { records: change.after } : {}),
    });
  }
  return { action, rows, notices };
}

/** `assignedTo` / `access_level` → "Assigned to" / "Access level" — the fallback field label. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_.-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced.length === 0 ? key : spaced[0]!.toUpperCase() + spaced.slice(1);
}
