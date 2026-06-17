import { parse as parseCsvSync } from 'csv-parse/sync';

/**
 * Migrator INGEST parser (ADR-0069 wave 2, #629). Turns an UNTRUSTED uploaded buffer (CSV or JSON)
 * into RAW rows — a `{ [header]: string }` per record — plus the detected `{ headers, dialect,
 * encoding, rowCount }`. This is the parse step ONLY: every cell stays a verbatim string and NOTHING
 * is coerced or validated here (the coercion pre-pass + `CreateAssetSchema` validation run at dry-run
 * in wave 3, ADR-0069 §3). Pure + DI-free so the sandboxed worker child and the Jest specs both call
 * it directly.
 *
 * SECURITY: this runs inside the forked, heap-capped, concurrency-1 sandbox worker (SEC-002) behind
 * the multer size cap (SEC-001) and a record-count quota. It NEVER throws on malformed input that is
 * still "a file" — ragged rows, header-only, empty, a non-array JSON — those become a structured
 * failure the worker records on the session. It never crashes the child.
 */

/** The two formats phase 1 accepts (ADR-0069: JSON + CSV; `.xlsx` is rejected upstream). */
export type ImportFormat = 'csv' | 'json';

/** A single parsed source record: header/key → verbatim string cell. */
export type RawRow = Record<string, string>;

/** What the parser detected about the input, surfaced for the confirmation/mapping step. */
export interface ParseDialect {
  /** CSV field delimiter actually used (`,` `;` `\t` `|`), or `null` for JSON. */
  delimiter: string | null;
  /** True when a UTF-8 BOM was present and stripped. */
  hadBom: boolean;
}

/** Successful parse: the raw rows plus the detected shape. */
export interface ParseSuccess {
  ok: true;
  headers: string[];
  dialect: ParseDialect;
  /** Always `'utf-8'` in phase 1 (the only encoding we accept; see {@link decodeUtf8}). */
  encoding: 'utf-8';
  rowCount: number;
  rows: RawRow[];
}

/** A graceful, recorded parse failure — NEVER a thrown crash out of the worker. */
export interface ParseFailure {
  ok: false;
  /** A short, PII-free, operator-facing reason (no file contents, no stack). */
  reason: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/** The CSV delimiters we sniff, most-common first. */
const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * The record-count quota (SEC-001 sibling of the size cap): a hard ceiling on parsed rows so a small
 * but pathologically dense file can't materialize unbounded `ImportRow`s. Overridable via
 * `MAX_IMPORT_ROWS`; the worker enforces this AFTER parse (the parser reports the count, the worker
 * rejects over-quota) so the limit is honored regardless of which path produced the rows.
 */
export const DEFAULT_MAX_IMPORT_ROWS = 50_000;

/** Resolve the row-count quota from the environment (falls back on a missing/bad value). */
export function maxImportRows(): number {
  const raw = process.env.MAX_IMPORT_ROWS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MAX_IMPORT_ROWS;
}

/**
 * Decode an uploaded buffer as UTF-8 and strip a leading BOM. We deliberately accept ONLY UTF-8
 * (ADR-0069 §12 — `.xlsx` and exotic encodings are rejected with an "export to CSV UTF-8" message);
 * a UTF-16/Latin-1 file decodes to mojibake here, which the JSON/CSV structure check below then
 * rejects as malformed rather than silently importing garbage. Returns the text + whether a BOM was
 * present.
 */
function decodeUtf8(buffer: Buffer): { text: string; hadBom: boolean } {
  // A UTF-8 BOM is the bytes EF BB BF. `csv-parse` strips it with `bom:true`, but JSON.parse chokes
  // on it, so we strip it once here for both paths and report it as detected metadata.
  const hadBom =
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf;
  const text = buffer.toString('utf-8');
  return { text: hadBom ? text.slice(1) : text, hadBom };
}

/**
 * Sniff the CSV delimiter from the first non-empty line: pick the candidate with the highest count
 * OUTSIDE quotes (so a comma inside `"a,b"` doesn't beat a real `;`). Defaults to `,` when nothing
 * scores — a single-column file then parses fine as one header.
 */
function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  let best = ',';
  let bestCount = -1;
  for (const delim of CANDIDATE_DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === delim && !inQuotes) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = delim;
    }
  }
  return best;
}

/**
 * Parse a CSV string into raw rows keyed by header. Uses `csv-parse` (RFC-4180: quoting, embedded
 * newlines, escaped quotes) in ARRAY mode — NOT `columns:true` — so we own header extraction and can
 * report ragged rows precisely. `relax_*` options keep a slightly-irregular real-world export from
 * throwing; raggedness is RECORDED, not fatal: short rows pad to absent (`''`), extra cells are
 * dropped.
 */
function parseCsv(text: string): ParseResult {
  const delimiter = sniffDelimiter(text);
  let records: string[][];
  try {
    records = parseCsvSync(text, {
      // The buffer was already BOM-stripped by decodeUtf8, but keep this on as belt-and-braces.
      bom: true,
      delimiter,
      // Keep verbatim cells: never auto-cast, never coerce — that is wave 3.
      cast: false,
      // Tolerate real-world irregularity instead of crashing the child: blank lines are skipped,
      // ragged rows are kept (we reconcile against the header width below), trailing delimiters and
      // stray quotes are relaxed. The header-count check downstream is the real validation gate.
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: false,
    }) as string[][];
  } catch (err) {
    return {
      ok: false,
      reason: `Could not parse the CSV file (${(err as Error).message.split('\n')[0]}).`,
    };
  }

  if (records.length === 0) {
    return { ok: false, reason: 'The CSV file is empty.' };
  }
  const headers = records[0].map((h) => h.trim());
  if (headers.length === 0 || headers.every((h) => h === '')) {
    return { ok: false, reason: 'The CSV file has no header row.' };
  }
  if (records.length === 1) {
    return { ok: false, reason: 'The CSV file has a header but no data rows.' };
  }
  // Reject duplicate headers: a `{ header: value }` map can't represent two columns of the same name
  // without silently dropping one (a data-loss footgun on import).
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h)) {
      return {
        ok: false,
        reason: `The CSV file has a duplicate column header ("${h}"). Rename the columns so each is unique.`,
      };
    }
    seen.add(h);
  }

  const rows: RawRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const cells = records[i];
    const row: RawRow = {};
    for (let c = 0; c < headers.length; c++) {
      // Short rows → absent cells become '' (coercion treats '' as absent in wave 3). Extra cells
      // beyond the header width are dropped (ragged-row tolerance).
      row[headers[c]] = cells[c] ?? '';
    }
    rows.push(row);
  }

  return {
    ok: true,
    headers,
    // hadBom is overwritten by parseImport from the original buffer (this path sees only text).
    dialect: { delimiter, hadBom: false },
    encoding: 'utf-8',
    rowCount: rows.length,
    rows,
  };
}

/**
 * Parse a JSON string. Accepts the four real-world shapes (ADR-0069 §2): a bare array `[...]`, an
 * envelope `{ "data": [...] }`, NDJSON (one object per line), or a single object (treated as a
 * one-row import). Each element MUST be a flat object; non-array/non-object JSON, or an array of
 * non-objects, is a recorded failure (never a crash). Every scalar is stringified to a raw cell so
 * the downstream coercion pre-pass sees the same shape as CSV.
 */
function parseJson(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'The JSON file is empty.' };
  }

  let elements: unknown[];
  // First try whole-document JSON (array / envelope / single object); fall back to NDJSON.
  let parsed: unknown;
  let wholeDocOk = true;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    wholeDocOk = false;
  }

  if (wholeDocOk) {
    if (Array.isArray(parsed)) {
      elements = parsed;
    } else if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { data?: unknown }).data)
    ) {
      elements = (parsed as { data: unknown[] }).data;
    } else if (parsed !== null && typeof parsed === 'object') {
      // A single object → a one-row import.
      elements = [parsed];
    } else {
      return {
        ok: false,
        reason:
          'The JSON file must be an array of records, an object with a "data" array, or a single record object.',
      };
    }
  } else {
    // NDJSON: each non-empty line is its own JSON object.
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const ndjson: unknown[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        ndjson.push(JSON.parse(lines[i]));
      } catch {
        return {
          ok: false,
          reason: `The JSON file is not valid JSON (and not valid NDJSON — line ${i + 1} failed to parse).`,
        };
      }
    }
    elements = ndjson;
  }

  if (elements.length === 0) {
    return { ok: false, reason: 'The JSON file has no records.' };
  }

  // Every element must be a flat object. Collect the union of keys (in first-seen order) as headers.
  const headers: string[] = [];
  const headerSet = new Set<string>();
  const rows: RawRow[] = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el === null || typeof el !== 'object' || Array.isArray(el)) {
      return {
        ok: false,
        reason: `Record ${i + 1} in the JSON file is not an object. Each record must be a flat object of fields.`,
      };
    }
    const row: RawRow = {};
    for (const [key, value] of Object.entries(el as Record<string, unknown>)) {
      if (!headerSet.has(key)) {
        headerSet.add(key);
        headers.push(key);
      }
      row[key] = stringifyCell(value);
    }
    rows.push(row);
  }

  if (headers.length === 0) {
    return { ok: false, reason: 'The JSON records have no fields.' };
  }

  // Backfill missing keys to '' so every row has every header (a sparse JSON record is legal).
  for (const row of rows) {
    for (const h of headers) {
      if (!(h in row)) row[h] = '';
    }
  }

  return {
    ok: true,
    headers,
    dialect: { delimiter: null, hadBom: false },
    encoding: 'utf-8',
    rowCount: rows.length,
    rows,
  };
}

/**
 * Stringify a JSON scalar to a raw cell, matching the "everything is a string" CSV shape so the
 * single coercion pre-pass (wave 3) treats both formats identically. `null`/`undefined` → `''`
 * (absent); objects/arrays → JSON text (the coercion pass will reject what it can't use — phase 1
 * has no nested-field mapping).
 */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Object/array — keep it as JSON text rather than `[object Object]`; not mappable in phase 1.
  return JSON.stringify(value);
}

/**
 * Parse an uploaded buffer of the given format into raw rows + detected shape. The single entry point
 * the worker calls. Decodes UTF-8 + strips a BOM, then dispatches. Returns a structured result
 * (success or graceful failure) — it does not throw on malformed-but-present input.
 */
export function parseImport(buffer: Buffer, format: ImportFormat): ParseResult {
  if (buffer.length === 0) {
    return { ok: false, reason: 'The uploaded file is empty.' };
  }
  const { text, hadBom } = decodeUtf8(buffer);
  const result = format === 'csv' ? parseCsv(text) : parseJson(text);
  // Stamp the real BOM detection (the CSV path can't see the original buffer).
  if (result.ok) {
    result.dialect.hadBom = hadBom;
  }
  return result;
}
