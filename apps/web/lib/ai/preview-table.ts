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
 * - `<key>Defaulted: true` — that cell was filled in with a default, not given;
 * - `<key>Id` next to `<key>` — the id of the record the `<key>` cell names (`asset` + `assetId` on a
 *   purchase link card, #1478): not a column of its own, it links the `<key>` cell to its page.
 *
 * A cell whose value maps field names to `{ before, after }` (the values a linked asset gets, #1478) is a
 * list of changes, each labelled like a field row. An `{ amount, currency }` value is money.
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

/** One `field: before → after` of a cell that lists changes. */
export interface CellChange {
  field: string;
  before: PreviewValue;
  after: PreviewValue;
}

/** A cell value that may link to its entity. */
export interface TableCell {
  value: PreviewValue;
  /** Internal href built from the value's `{ type, id }` (or its `<key>Id`), when the web has a page for it. */
  href: string | null;
  /** The value was a default the server filled in (`<key>Defaulted: true`). */
  defaulted: boolean;
  /** Set when the value maps field names to `{ before, after }`: the changes, in the server's order. */
  changes?: CellChange[];
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

/** `{ field: { before, after } }` — a map of changes (at least one), and nothing else. */
function isChangeMap(value: unknown): value is Record<string, { before?: unknown; after?: unknown }> {
  if (!isPlainObject(value)) return false;
  const entries = Object.values(value);
  return (
    entries.length > 0 &&
    entries.every(
      (entry) =>
        isPlainObject(entry) && "after" in entry && Object.keys(entry).every((k) => k === "before" || k === "after"),
    )
  );
}

/** `<key>Id` is folded into the `<key>` column when the row carries both and the id is a string. */
function isFoldedId(item: Obj, key: string): boolean {
  if (!key.endsWith("Id") || key.length <= 2) return false;
  return key.slice(0, -2) in item && typeof item[key] === "string";
}

function cellOf(item: Obj, key: string): TableCell {
  const raw = item[key];
  let href: string | null = null;
  if (isPlainObject(raw) && typeof raw.type === "string" && typeof raw.id === "string") {
    href = entityHref({ type: raw.type, id: raw.id, slug: typeof raw.slug === "string" ? raw.slug : undefined });
  } else if (typeof item[`${key}Id`] === "string") {
    href = entityHref({ type: key, id: item[`${key}Id`] as string });
  }
  const defaulted = item[`${key}Defaulted`] === true;
  if (isChangeMap(raw)) {
    const changes = Object.entries(raw).map(([field, change]) => ({
      field,
      before: formatPreviewValue(change.before),
      after: formatPreviewValue(change.after),
    }));
    return { value: { kind: "empty" }, href: null, defaulted, changes };
  }
  return { value: formatPreviewValue(raw), href, defaulted };
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
      if (META_KEYS.has(key) || isDefaultedFlag(key) || isFoldedId(item, key) || present.has(key)) continue;
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

/**
 * A table as plain-text lines for the `/copy` transcript (#1478): one line per row, `Label: value` per
 * column, a change list as `Label before → after`. `value` and `label` are the transcript's own formatters,
 * so money keeps its currency label and locale there too. Pure.
 */
export function tableTranscriptLines(
  records: readonly Obj[],
  value: (v: PreviewValue) => string,
  label: (field: string) => string,
): string[] {
  const table = buildPreviewTable(records);
  return table.rows.map((row) => {
    const cells = table.columns.map((column) => {
      const cell = row.cells[column]!;
      const shown = cell.changes
        ? cell.changes.map((c) => `${label(c.field)} ${value(c.before)} → ${value(c.after)}`).join(", ")
        : value(cell.value);
      return `${label(column)}: ${shown}`;
    });
    return `${row.number}. ${cells.join("; ")}`;
  });
}
