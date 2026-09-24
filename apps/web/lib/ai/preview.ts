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

export interface PreviewRow {
  field: string;
  before: PreviewValue | null;
  after: PreviewValue;
}

export interface PreviewModel {
  /** The plain-language sentence of the `action` row, shown first. */
  action: { text: string; untrusted: boolean } | null;
  rows: PreviewRow[];
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

/** Splits the preview into its `action` sentence (the first row by convention) and the field rows. */
export function presentPreview(preview: Pick<AiActionPreview, "changes">): PreviewModel {
  let action: PreviewModel["action"] = null;
  const rows: PreviewRow[] = [];
  for (const change of preview.changes) {
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
    });
  }
  return { action, rows };
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
