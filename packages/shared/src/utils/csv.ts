// CSV conventions of the export engine (ADR-0103). The legacy escapeCsvCell stays until the old exports move.

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

/** One RFC-4180 cell. Only `text` is guarded: a server-formatted number stays `-5`, never `'-5`. */
export function csvCell(value: string, kind: CsvCellKind = "text"): string {
  return quoteCsv(kind === "text" ? guardCsvFormula(value) : value);
}
