// CSV conventions of the export engine (ADR-0103).

/** Byte-order mark, so Excel on Windows reads the file as UTF-8. */
export const CSV_BOM = "\uFEFF";

/** RFC-4180 line ending. */
export const CSV_EOL = "\r\n";

export const CSV_CELL_KINDS = ["text", "number", "date", "money"] as const;
export type CsvCellKind = (typeof CSV_CELL_KINDS)[number];

// OWASP's trigger set plus `\n` and the full-width = + - @ that spreadsheets also evaluate.
const FORMULA_TRIGGER = /^[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/;

/** Prefix a single quote when a spreadsheet would read the value as a formula. */
export function guardCsvFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

function quoteCsv(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const RAW_NUMBER = /^-?\d+(\.\d+)?$/;
const RAW_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$/;

/** One RFC-4180 cell. A non-text cell skips the guard only when it really is a number or a timestamp, so `-5` stays `-5`. */
export function csvCell(value: string, kind: CsvCellKind = "text"): string {
  const raw =
    kind !== "text" && (RAW_NUMBER.test(value) || RAW_TIMESTAMP.test(value));
  return quoteCsv(raw ? value : guardCsvFormula(value));
}
