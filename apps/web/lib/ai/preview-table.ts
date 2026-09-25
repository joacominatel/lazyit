import { entityHref } from "./entity-href";
import { formatPreviewValue, type PreviewValue, type PreviewRecord } from "./preview";
import { stripUntrusted } from "./untrusted-text";

/**
 * The approval card's table presenter (issue #1387). A preview `after` that is an array of objects — the
 * rows of `asset_create_batch`, or any future tool that proposes several records at once — is shown as a
 * table instead of the flat, 500-character joined text a scalar array gets. It is generic: the columns
 * come from the keys the rows carry, in a preferred order, and a few well-known keys drive the row state:
 *
 * - `row` — the 1-based row number (else the position);
 * - `skipped: true` or `valid: false` — the row is NOT applied ("will be skipped");
 * - `errors: string[]` and `duplicates: [{ field, value, existing?, row? }]` — the row's problems;
 * - `<key>Defaulted: true` — that cell was filled in with a default, not given.
 *
 * Every value is reduced to plain text here, like the rest of the card (`preview.ts`); links are built
 * only through `entityHref` from `{ type, id }`, never taken from the payload.
 */

/** Keys that describe the row rather than being one of its columns. */
const META_KEYS = new Set(["row", "valid", "skipped", "errors", "duplicates"]);

/**
 * The preferred column order; any other key follows in first-seen order. `asset` — the existing asset a
 * row of `asset_update_batch` changes — leads, so each row starts with what it changes (#1412); a table
 * without it (`asset_create_batch`) keeps `name` first.
 */
const PREFERRED_COLUMNS = [
  "asset",
  "name",
  "title",
  "assetTag",
  "serial",
  "model",
  "category",
  "location",
  "status",
];

/** A cell value that may link to its entity. */
export interface TableCell {
  value: PreviewValue;
  /** Internal href built from the value's `{ type, id }`, when the web has a page for it. */
  href: string | null;
  /** The value was a default the server filled in (`<key>Defaulted: true`). */
  defaulted: boolean;
}

export type TableProblem =
  | { kind: "error"; text: string }
  | {
      kind: "duplicateExisting";
      field: string;
      value: string;
      label: string;
      href: string | null;
    }
  | { kind: "duplicateRow"; field: string; value: string; row: number };

export interface TableRow {
  /** 1-based, as the server numbered it. */
  number: number;
  /** False when the row will be skipped (not applied). */
  applied: boolean;
  cells: Record<string, TableCell>;
  problems: TableProblem[];
}

export interface PreviewTable {
  /** Column keys (preview field keys, labelled like a field row). */
  columns: string[];
  rows: TableRow[];
  /** Rows not applied. */
  skippedCount: number;
  /** Rows skipped or with at least one problem — what "only problems" shows. */
  problemCount: number;
}

type Obj = PreviewRecord;

function isPlainObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefaultedFlag(key: string): boolean {
  return key.length > "Defaulted".length && key.endsWith("Defaulted");
}

function cellOf(item: Obj, key: string): TableCell {
  const raw = item[key];
  let href: string | null = null;
  if (isPlainObject(raw) && typeof raw.type === "string" && typeof raw.id === "string") {
    href = entityHref({ type: raw.type, id: raw.id, slug: typeof raw.slug === "string" ? raw.slug : undefined });
  }
  return { value: formatPreviewValue(raw), href, defaulted: item[`${key}Defaulted`] === true };
}

function text(value: unknown): string {
  if (typeof value === "string") return stripUntrusted(value).text;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function problemsOf(item: Obj): TableProblem[] {
  const problems: TableProblem[] = [];
  const covered: string[] = [];
  if (Array.isArray(item.duplicates)) {
    for (const dup of item.duplicates) {
      if (!isPlainObject(dup)) continue;
      const field = text(dup.field);
      const value = text(dup.value);
      if (field === "") continue;
      covered.push(`${field} "${value}" `);
      const existing = dup.existing;
      if (isPlainObject(existing) && typeof existing.id === "string") {
        const type = typeof existing.type === "string" ? existing.type : "asset";
        problems.push({
          kind: "duplicateExisting",
          field,
          value,
          label: text(existing.label) || existing.id,
          href: entityHref({ type, id: existing.id }),
        });
      } else if (typeof dup.row === "number" && Number.isInteger(dup.row)) {
        problems.push({ kind: "duplicateRow", field, value, row: dup.row });
      }
    }
  }
  if (Array.isArray(item.errors)) {
    for (const error of item.errors) {
      const message = text(error).trim();
      if (message === "") continue;
      // The server also words each duplicate as an error (`assetTag "X" already belongs to …`); the
      // structured duplicate above says the same with a link, so its sentence is not repeated.
      if (covered.some((prefix) => message.startsWith(prefix))) continue;
      problems.push({ kind: "error", text: message.length > 500 ? `${message.slice(0, 500)}…` : message });
    }
  }
  return problems;
}

/** Builds the table for an array of row objects. Pure. */
export function buildPreviewTable(items: readonly Obj[]): PreviewTable {
  const present = new Set<string>();
  const order: string[] = [];
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (META_KEYS.has(key) || isDefaultedFlag(key) || present.has(key)) continue;
      present.add(key);
      order.push(key);
    }
  }
  const columns = [
    ...PREFERRED_COLUMNS.filter((key) => present.has(key)),
    ...order.filter((key) => !PREFERRED_COLUMNS.includes(key)),
  ];

  let skippedCount = 0;
  let problemCount = 0;
  const rows = items.map((item, index): TableRow => {
    const applied = item.skipped !== true && item.valid !== false;
    const problems = problemsOf(item);
    if (!applied) skippedCount += 1;
    if (!applied || problems.length > 0) problemCount += 1;
    const cells: Record<string, TableCell> = {};
    for (const key of columns) cells[key] = cellOf(item, key);
    const number = typeof item.row === "number" && Number.isInteger(item.row) ? item.row : index + 1;
    return { number, applied, cells, problems };
  });
  return { columns, rows, skippedCount, problemCount };
}

/** The rows the table shows: all, or only those skipped or with a problem. */
export function visibleTableRows(table: PreviewTable, onlyProblems: boolean): TableRow[] {
  return onlyProblems ? table.rows.filter((row) => !row.applied || row.problems.length > 0) : table.rows;
}
