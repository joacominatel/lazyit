import type { CsvCellKind } from '@lazyit/shared';
import { moneyCell, type ExportCellValue, type ExportColumn } from './export-column';

// The SpreadsheetML parts of a one-sheet workbook (ADR-0103 §11). Text is always an inline string,
// never a formula, so a cell starting with `=` is shown, not evaluated, and needs no `'` guard.

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Excel refuses a cell longer than this; a longer text is cut to it. */
export const XLSX_MAX_CELL_CHARS = 32_767;

/** Cell style indexes into `cellXfs` of {@link XLSX_STYLES}. */
export const XLSX_STYLE = {
  default: 0,
  header: 1,
  date: 2,
  dateTime: 3,
  money: 4,
} as const;

export const XLSX_CONTENT_TYPES =
  `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

export const XLSX_ROOT_RELS =
  `${XML_DECL}<Relationships xmlns="${PKG_REL_NS}">` +
  `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
  '</Relationships>';

export const XLSX_WORKBOOK_RELS =
  `${XML_DECL}<Relationships xmlns="${PKG_REL_NS}">` +
  `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/>` +
  '</Relationships>';

const XF = 'fontId="0" fillId="0" borderId="0" xfId="0"';

// 164/165 are the first custom format ids; 4 is the built-in `#,##0.00`.
export const XLSX_STYLES =
  `${XML_DECL}<styleSheet xmlns="${MAIN_NS}">` +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>' +
  '<numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  `<xf numFmtId="0" ${XF}/>` +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  `<xf numFmtId="164" ${XF} applyNumberFormat="1"/>` +
  `<xf numFmtId="165" ${XF} applyNumberFormat="1"/>` +
  `<xf numFmtId="4" ${XF} applyNumberFormat="1"/>` +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** `0` → `A`, `25` → `Z`, `26` → `AA`. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const HEX4 = (code: number) => code.toString(16).toUpperCase().padStart(4, '0');
// XML 1.0 forbids C0 controls other than tab/LF; CR survives only escaped. Lone surrogates are not text.
const ESCAPED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F]/g;
const NOT_XML_CHAR =
  /[￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function truncateCell(value: string): string {
  if (value.length <= XLSX_MAX_CELL_CHARS) return value;
  let cut = value.slice(0, XLSX_MAX_CELL_CHARS);
  // Never leave half of a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

/**
 * One text value as the body of an inline string `<t>`: cut to Excel's cell limit, a literal
 * `_xHHHH_` kept literal (`_x005F_`), control characters as `_xHHHH_` (ECMA-376 ST_Xstring),
 * characters XML cannot hold replaced with U+FFFD, then XML-escaped.
 */
export function xlsxText(value: string): string {
  return escapeXml(
    truncateCell(value)
      .replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1')
      .replace(ESCAPED_CONTROL, (c) => `_x${HEX4(c.charCodeAt(0))}_`)
      .replace(NOT_XML_CHAR, '�'),
  );
}

const MS_PER_DAY = 86_400_000;
// 1970-01-01 is serial 25569 in the 1900 date system; below 61 the 1900 leap-year bug shifts days.
const UNIX_EPOCH_SERIAL = 25_569;
const FIRST_SAFE_SERIAL = 61;
const RAW_NUMBER = /^-?\d+(\.\d+)?$/;
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** A UTC instant as an Excel serial date; `null` before 1900-03-01. */
export function excelSerial(date: Date): number | null {
  const serial = date.getTime() / MS_PER_DAY + UNIX_EPOCH_SERIAL;
  return serial >= FIRST_SAFE_SERIAL ? serial : null;
}

function isMidnightUtc(date: Date): boolean {
  return date.getTime() % MS_PER_DAY === 0;
}

function inlineCell(ref: string, text: string, style: number): string {
  const s = style === XLSX_STYLE.default ? '' : ` s="${style}"`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xlsxText(text)}</t></is></c>`;
}

function numberCell(ref: string, value: string, style: number): string {
  const s = style === XLSX_STYLE.default ? '' : ` s="${style}"`;
  return `<c r="${ref}"${s}><v>${value}</v></c>`;
}

function dateCell(ref: string, date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null;
  const serial = excelSerial(date);
  if (serial === null) return inlineCell(ref, date.toISOString(), 0);
  return numberCell(
    ref,
    String(serial),
    isMidnightUtc(date) ? XLSX_STYLE.date : XLSX_STYLE.dateTime,
  );
}

function numericText(value: number | bigint): string | null {
  if (typeof value === 'bigint') return value.toString();
  return Number.isFinite(value) ? String(value) : null;
}

/**
 * One typed cell, or `null` for an empty one. `number` → a number; `money` (integer minor units,
 * ADR-0100) → the exact major-unit number in `#,##0.00`; `date` → a real date, date-only when the
 * value is a UTC midnight, else date and time (UTC). A value that is not of its column's type falls
 * back to an inline string, so nothing is ever lost or read as a formula.
 */
export function xlsxCell(
  ref: string,
  value: ExportCellValue,
  kind: CsvCellKind,
): string | null {
  if (value === null || value === undefined) return null;
  if (kind === 'text') {
    return inlineCell(
      ref,
      value instanceof Date ? value.toISOString() : String(value),
      XLSX_STYLE.default,
    );
  }
  if (kind === 'date') {
    if (value instanceof Date) return dateCell(ref, value);
    if (typeof value === 'string' && ISO_DATE.test(value)) {
      return dateCell(ref, new Date(value));
    }
  }
  if (kind === 'number') {
    if (typeof value === 'number' || typeof value === 'bigint') {
      const text = numericText(value);
      return text === null ? null : numberCell(ref, text, XLSX_STYLE.default);
    }
    if (typeof value === 'string' && RAW_NUMBER.test(value)) {
      return numberCell(ref, value, XLSX_STYLE.default);
    }
  }
  if (kind === 'money') {
    if (typeof value === 'bigint' || Number.isSafeInteger(value)) {
      return numberCell(
        ref,
        moneyCell(value as number | bigint),
        XLSX_STYLE.money,
      );
    }
    // A string in a money column is already major units, as in the CSV.
    if (typeof value === 'string' && RAW_NUMBER.test(value)) {
      return numberCell(ref, value, XLSX_STYLE.money);
    }
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return inlineCell(
    ref,
    value instanceof Date ? value.toISOString() : String(value),
    XLSX_STYLE.default,
  );
}

function columnWidth(column: ExportColumn<unknown>): number {
  const header = column.header.length + 2;
  switch (column.kind) {
    case 'date':
      return Math.max(header, 20);
    case 'money':
      return Math.max(header, 14);
    case 'number':
      return Math.max(header, 10);
    default:
      return Math.min(Math.max(header, 24), 60);
  }
}

/** Excel's sheet-name rules: at most 31 characters, none of `[]:*?/\`, not blank. */
export function xlsxSheetName(name: string): string {
  const clean = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return clean === '' ? 'Sheet1' : clean;
}

function lastRef<T>(columns: readonly ExportColumn<T>[], rows: number): string {
  return `${columnLetter(columns.length - 1)}${rows}`;
}

/**
 * The workbook part. Written after the sheet so the hidden `_FilterDatabase` name can carry the
 * autofilter's exact range, as Excel itself writes it.
 */
export function xlsxWorkbook(
  sheetName: string,
  columnCount: number,
  totalRows: number,
): string {
  const name = xlsxSheetName(sheetName);
  const quoted = `'${name.replace(/'/g, "''")}'`;
  const range = `$A$1:$${columnLetter(columnCount - 1)}$${Math.max(totalRows, 1)}`;
  return (
    `${XML_DECL}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<sheets><sheet name="${escapeXml(name)}" sheetId="1" r:id="rId1"/></sheets>` +
    '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' +
    `${escapeXml(`${quoted}!${range}`)}</definedName></definedNames>` +
    '</workbook>'
  );
}

function rowXml<T>(
  columns: readonly ExportColumn<T>[],
  row: T,
  rowNumber: number,
): string {
  let cells = '';
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    const cell = xlsxCell(
      `${columnLetter(i)}${rowNumber}`,
      column.value(row),
      column.kind,
    );
    if (cell !== null) cells += cell;
  }
  return `<row r="${rowNumber}">${cells}</row>`;
}

export interface StreamSheetOptions<T> {
  columns: readonly ExportColumn<T>[];
  batches: AsyncIterable<readonly T[]>;
  /** Called once, after the last row, with the sheet's row count including the header. */
  onEnd?: (totalRows: number) => void;
}

/**
 * The worksheet part, one chunk per batch: a frozen bold header with an autofilter over the
 * written rows, then one row per record. Only the current batch is ever held.
 */
export async function* streamSheetXml<T>({
  columns,
  batches,
  onEnd,
}: StreamSheetOptions<T>): AsyncGenerator<Buffer> {
  const cols = columns
    .map(
      (c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${columnWidth(c as ExportColumn<unknown>)}" customWidth="1"/>`,
    )
    .join('');
  const header = columns
    .map((c, i) => inlineCell(`${columnLetter(i)}1`, c.header, XLSX_STYLE.header))
    .join('');
  yield Buffer.from(
    `${XML_DECL}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
      '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      `<cols>${cols}</cols>` +
      `<sheetData><row r="1">${header}</row>`,
    'utf8',
  );
  let rowNumber = 1;
  for await (const rows of batches) {
    if (rows.length === 0) continue;
    let chunk = '';
    for (const row of rows) chunk += rowXml(columns, row, ++rowNumber);
    yield Buffer.from(chunk, 'utf8');
  }
  yield Buffer.from(
    `</sheetData><autoFilter ref="A1:${lastRef(columns, rowNumber)}"/></worksheet>`,
    'utf8',
  );
  onEnd?.(rowNumber);
}
